import type { App, TFile } from "obsidian";
import {
	extractUidFromFrontmatter,
	generateUid as genUid,
	updateUidFrontmatter,
	validateUid,
} from "src/core/uidRules";
import {
	getOptimalConcurrency,
	KeyedQueue,
	runPool,
} from "src/lib/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import { toFailure } from "src/lib/errors/mapper";
import {
	type AppFailure,
	type AppResult,
	isAppFailure,
} from "src/lib/errors/types";
import { Pathing } from "src/lib/pathing";
import {
	composeSnapshotContent,
	computeSnapshotHash,
	generateBackupFileName,
	legacySnapshotPathFor,
	snapshotErrors,
	snapshotPathForUid,
	verifySnapshotIntegrity,
} from "src/lib/snapshotCore";
import type { NoteUpdater } from "src/types";
import type { FileSystemService, FolderScanResult } from "../FileSystemService";
import type { ImportWarning } from "../import/types";
import type { LoggingService } from "../LoggingService";
import type { NoteEditorService } from "../parsing/NoteEditorService";
import { notifyOnFsError } from "../ui/notificationUtils";

// consolidated error type for all persistence operations.
type NotePersistenceFailure = AppFailure;

/**
 * A cohesive service responsible for a note's persistent state, including its
 * unique identity (kohl-uid) and historical snapshots for 3-way merging.
 */
export class NotePersistenceService {
	private readonly log;
	private readonly snapshotDir: string;
	private readonly backupDir: string;
	private readonly queue = new KeyedQueue();

	constructor(
		private readonly app: App,
		private readonly noteEditorService: NoteEditorService,
		private readonly fs: FileSystemService,
		private readonly loggingService: LoggingService,
	) {
		this.log = this.loggingService.scoped("NotePersistenceService");
		this.snapshotDir = this.fs.joinPluginDataPath("snapshots");
		this.backupDir = this.fs.joinPluginDataPath("backups");
	}

	private withFileLock<T>(
		fileOrPath: TFile | string,
		task: () => Promise<T>,
	): Promise<T> {
		const path = typeof fileOrPath === "string" ? fileOrPath : fileOrPath.path;
		return this.queue.run(`file:${path}`, task);
	}

	public generateUid(): string {
		return genUid();
	}

	public tryGetId(file: TFile): string | undefined {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return extractUidFromFrontmatter(fm as Record<string, unknown>);
	}

	public async ensureId(file: TFile): Promise<Result<string, AppFailure>> {
		const existingUid = this.tryGetId(file);
		if (validateUid(existingUid)) {
			return ok(existingUid);
		}
		return this.assignNewId(file, existingUid);
	}

	public async assignNewId(
		file: TFile,
		oldUid?: string,
		opts?: { targetUid?: string },
	): Promise<Result<string, AppFailure>> {
		return this.withFileLock(file, async () => {
			const newUid = opts?.targetUid ?? this.generateUid();

			if (!oldUid || oldUid === newUid) {
				// Pass through targetUid for idempotency
				return this.updateFrontmatterUid(file, newUid, oldUid);
			}

			return this.withTwoSnapshotLocks(oldUid, newUid, async () => {
				const status = await this.checkMigrationStatus(oldUid, newUid);

				if (status.oldExists && !status.newExists) {
					const read = await this.readSnapshot(oldUid);
					if (isErr(read)) return err(read.error as AppFailure);

					const write = await this.writeSnapshot(newUid, read.value);
					if (isErr(write)) return err(write.error as AppFailure);
				} else if (!status.oldExists) {
					this.log.warn(
						`assignNewId: No snapshot for old UID ${oldUid}; proceeding without baseline.`,
					);
				}

				const commit = await this.updateFrontmatterUid(file, newUid, oldUid);

				if (isErr(commit)) {
					if (status.oldExists && !status.newExists) {
						const rb = await this.removeSnapshot(newUid);
						if (isErr(rb)) {
							this.log.error(
								`CRITICAL: Rollback failed for ${newUid} after commit error.`,
								rb.error,
							);
						}
					}
					return commit;
				}

				if (status.oldExists) {
					const rm = await this.removeSnapshot(oldUid);
					if (isErr(rm)) {
						this.log.warn(
							`assignNewId: Succeeded, but failed to clean up old snapshot ${oldUid}.`,
							rm.error,
						);
					}
				}

				return ok(newUid);
			});
		});
	}

	public async createSnapshotFromContent(
		uid: string,
		content: string,
	): Promise<Result<void, NotePersistenceFailure>> {
		return this.createSnapshotCore(null, uid, async () => content);
	}

	public async readSnapshotById(
		uid: string,
	): Promise<Result<string, AppFailure>> {
		return this.readSnapshot(uid);
	}

	public async createBackup(
		targetFile: TFile,
	): Promise<Result<void, NotePersistenceFailure>> {
		const backupFileName = generateBackupFileName(
			targetFile.basename,
			targetFile.path,
		);
		const backupPath = Pathing.joinVaultPath(this.backupDir, backupFileName);

		const readResult = await this.fs.readVaultTextWithRetry(targetFile);
		if (isErr(readResult)) {
			return err(
				snapshotErrors.readFailed(
					`Failed to read for backup`,
					readResult.error,
				),
			);
		}

		const writeResult = await notifyOnFsError(
			this.fs.writeVaultTextAtomic(backupPath, readResult.value),
			{
				message:
					"KOReader Importer: Failed to create backup. Check folder permissions.",
				onceKey: "snapshotsWritable",
			},
		);

		if (isErr(writeResult)) {
			return err(
				snapshotErrors.writeFailed(
					`Failed to create backup`,
					writeResult.error,
				),
			);
		}

		this.log.info(`Created backup for ${targetFile.path} at ${backupPath}`);
		return ok(undefined);
	}

	public async cleanupOldBackups(
		retentionDays: number,
	): Promise<Result<void, AppFailure>> {
		if (retentionDays <= 0) {
			return ok(undefined);
		}

		this.log.info(`Cleaning backups older than ${retentionDays} days...`);

		const getFilesPromise: Promise<AppResult<FolderScanResult>> = (async () => {
			try {
				const result = await this.fs.getFilesInFolder(this.backupDir, {
					extensions: ["md"],
					recursive: true,
				});
				return ok(result);
			} catch (e) {
				return err(toFailure(e, this.backupDir, "ReadFailed"));
			}
		})();

		const scanResult = await notifyOnFsError(getFilesPromise, {
			message: "KOReader Importer: Could not clean up old backups.",
			onceKey: "snapshotsWritable",
		});

		if (isErr(scanResult)) {
			if (scanResult.error.kind === "NotFound") {
				return ok(undefined);
			}
			return err(scanResult.error as AppFailure);
		}

		const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
		const oldFiles = scanResult.value.files.filter((file: TFile) => {
			return file.stat.mtime < cutoffTime;
		});

		if (oldFiles.length === 0) {
			return ok(undefined);
		}

		let deletedCount = 0;
		const concurrency = getOptimalConcurrency({ min: 1 });

		const resultsStream = runPool(
			oldFiles,
			async (file: TFile) => {
				const removeResult = await this.fs.removeVaultPath(file.path);
				if (isErr(removeResult)) {
					this.log.warn(
						`Failed to delete old backup: ${file.path}`,
						removeResult.error,
					);
				}
				return !isErr(removeResult);
			},
			{ concurrency },
		);

		for await (const result of resultsStream) {
			if (result.ok && result.value === true) {
				deletedCount++;
			}
		}

		this.log.info(`Cleanup complete. Deleted ${deletedCount} old backup(s).`);
		return ok(undefined);
	}

	public async migrateSingleLegacySnapshot(
		file: TFile,
		uid: string,
	): Promise<Result<void, NotePersistenceFailure>> {
		const legacyPath = legacySnapshotPathFor(this.snapshotDir, file.path);

		return this.withSnapshotLock(uid, async () => {
			const legacyExistsRes = await this.fs.vaultExists(legacyPath);
			if (isErr(legacyExistsRes) || !legacyExistsRes.value) {
				return ok(undefined);
			}

			if (await this.snapshotExists(uid)) {
				const removeResult = await this.fs.removeVaultPath(legacyPath);
				if (isErr(removeResult)) {
					this.log.warn(
						`Failed to remove legacy snapshot at ${legacyPath}`,
						removeResult.error,
					);
				}
				return ok(undefined);
			}

			const readRes = await this.fs.readVaultText(legacyPath);
			if (isErr(readRes)) {
				return err(
					snapshotErrors.readFailed(
						`Failed to read legacy snapshot`,
						readRes.error,
					),
				);
			}

			const writeRes = await this.writeSnapshot(uid, readRes.value);
			if (isErr(writeRes)) {
				return writeRes;
			}

			const removeResult = await this.fs.removeVaultPath(legacyPath);
			if (isErr(removeResult)) {
				this.log.warn(
					`Failed to remove legacy snapshot at ${legacyPath}`,
					removeResult.error,
				);
			}

			return ok(undefined);
		});
	}

	private async createSnapshotCore(
		targetFile: TFile | null,
		uid: string,
		contentProvider: () => Promise<string>,
	): Promise<Result<void, NotePersistenceFailure>> {
		if (!uid) {
			return err(
				snapshotErrors.uidMissing("Cannot create snapshot with empty UID."),
			);
		}

		return this.withSnapshotLock(uid, async () => {
			try {
				const content = await contentProvider();
				return this.writeSnapshot(uid, content);
			} catch (e) {
				const path = targetFile?.path ?? `UID ${uid}`;
				this.log.error(`Failed to get content for snapshot of ${path}`, e);
				return err(
					snapshotErrors.readFailed(
						`Failed to read content for snapshot of ${path}`,
						e,
					),
				);
			}
		});
	}

	private async checkMigrationStatus(
		oldUid: string,
		newUid: string,
	): Promise<{ oldExists: boolean; newExists: boolean }> {
		const [oldExists, newExists] = await Promise.all([
			this.snapshotExists(oldUid),
			this.snapshotExists(newUid),
		]);
		return { oldExists, newExists };
	}

	private async updateFrontmatterUid(
		file: TFile,
		newUid: string,
		oldUid?: string,
	): Promise<Result<string, AppFailure>> {
		try {
			await this.noteEditorService.editFrontmatter(file, (fm) => {
				const updated = updateUidFrontmatter(
					(fm as Record<string, unknown>) ?? {},
					newUid,
				);
				Object.assign(fm, updated);
			});
			return ok(newUid);
		} catch (e) {
			// Type guard for AppFailure
			if (isAppFailure(e)) {
				return err(e);
			}
			// Fallback: wrap unknown error
			return err({
				kind: "WriteFailed",
				path: file.path,
				cause: e,
			} as AppFailure);
		}
	}

	private async writeSnapshot(
		uid: string,
		body: string,
	): Promise<Result<void, NotePersistenceFailure>> {
		const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
		const hash = computeSnapshotHash(body);
		const content = composeSnapshotContent(hash, body);
		const writeResult = await notifyOnFsError(
			this.fs.writeVaultTextAtomic(path, content),
			{ onceKey: "snapshotsWritable" },
		);
		return isErr(writeResult)
			? err(
					snapshotErrors.writeFailed(
						`Failed to write snapshot for UID ${uid}`,
						writeResult.error,
					),
				)
			: ok(undefined);
	}

	private async readSnapshot(uid: string): Promise<Result<string, AppFailure>> {
		const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
		const r = await this.fs.readVaultText(path);
		if (isErr(r)) {
			const e = r.error;
			return e?.kind === "NotFound"
				? err(snapshotErrors.snapshotMissing(`No snapshot at ${path}`))
				: err(snapshotErrors.readFailed(`Failed to read ${path}`, r.error));
		}
		const verifyResult = verifySnapshotIntegrity(r.value, { path });
		if (isErr(verifyResult)) {
			const error = verifyResult.error;
			this.log.warn(
				`Snapshot integrity check failed for ${path}: ${error.kind}`,
				error,
			);
		}
		return verifyResult;
	}

	private async removeSnapshot(uid: string): Promise<Result<void, AppFailure>> {
		const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
		const res = await this.fs.removeVaultPath(path);
		return isErr(res)
			? err(snapshotErrors.writeFailed(`Failed to remove ${path}`, res.error))
			: ok(undefined);
	}

	private async snapshotExists(uid: string): Promise<boolean> {
		const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
		const ex = await this.fs.vaultExists(path);
		return !isErr(ex) && Boolean(ex.value);
	}

	private withSnapshotLock<T>(uid: string, task: () => Promise<T>): Promise<T> {
		const key = `snapshot:${uid}`;
		return this.queue.run(key, task);
	}

	private async withTwoSnapshotLocks<T>(
		a: string,
		b: string,
		task: () => Promise<T>,
	): Promise<T> {
		const [first, second] = [a, b].sort();
		return this.withSnapshotLock(first, () =>
			this.withSnapshotLock(second, task),
		);
	}

	public async createNoteAtomically(params: {
		folderPath: string;
		baseStem: string;
		content: string;
		signal?: AbortSignal;
	}): Promise<
		AppResult<{
			file: TFile;
			uid: string;
			snapshotCreated: boolean;
			warnings?: ImportWarning[];
		}>
	> {
		const { folderPath, baseStem, content, signal } = params;
		signal?.throwIfAborted();

		const createRes = await this.fs.createVaultFileUnique(
			folderPath,
			baseStem,
			content,
		);
		if (isErr(createRes)) return err(createRes.error);
		const { file: targetFile, warnings: initialWarnings } = createRes.value;

		// Lock the newly created file to perform UID, backup, and snapshot operations atomically.
		return this.withFileLock(targetFile, async () => {
			signal?.throwIfAborted();

			const uidResult = await this.ensureId(targetFile);
			if (isErr(uidResult)) return err(uidResult.error);
			const uid = uidResult.value;

			const warnings: ImportWarning[] = [...initialWarnings];
			const backupRes = await this.createBackup(targetFile);
			if (isErr(backupRes)) {
				warnings.push({
					code: "BACKUP_FAILED",
					message: "Backup creation failed for new note.",
				});
			}

			const snapRes = await this.createSnapshotFromContent(uid, content);
			if (isErr(snapRes)) {
				warnings.push({
					code: "SNAPSHOT_FAILED",
					message: "Snapshot creation failed for new note.",
				});
			}

			const snapshotCreated = !isErr(snapRes);

			return ok({
				file: targetFile,
				uid,
				snapshotCreated,
				warnings: warnings.length > 0 ? warnings : undefined,
			});
		});
	}

	public async updateNoteAtomically(params: {
		file: TFile;
		updater: NoteUpdater;
		uid?: string;
		signal?: AbortSignal;
	}): Promise<
		AppResult<{
			file: TFile;
			uid: string;
			snapshotCreated: boolean;
			warnings?: ImportWarning[];
		}>
	> {
		const { file: targetFile, updater, signal } = params;
		signal?.throwIfAborted();

		const uidResult = params.uid
			? ok(params.uid)
			: await this.ensureId(targetFile);
		if (isErr(uidResult)) return err(uidResult.error);
		const uid = uidResult.value;

		return this.withFileLock(targetFile, async () => {
			signal?.throwIfAborted();

			const warnings: ImportWarning[] = [];
			const backupRes = await this.createBackup(targetFile);
			if (isErr(backupRes)) {
				warnings.push({
					code: "BACKUP_FAILED",
					message: "Backup creation failed prior to write.",
				});
			}

			const editRes = await this.noteEditorService.editFile(
				targetFile,
				updater,
				{
					detectConcurrentModification: true,
					skipIfNoChange: true,
					signal,
					afterWrite: async (ctx) => {
						signal?.throwIfAborted();
						const snapRes = await this.createSnapshotFromContent(
							uid,
							ctx.newContent,
						);
						if (isErr(snapRes)) {
							warnings.push({
								code: "SNAPSHOT_FAILED",
								message: "Snapshot creation failed after note update.",
							});
						}
					},
				},
			);

			if (isErr(editRes)) return err(editRes.error);

			const snapshotCreated = !warnings.some(
				(w) => w.code === "SNAPSHOT_FAILED",
			);

			return ok({
				file: targetFile,
				uid,
				snapshotCreated,
				warnings: warnings.length > 0 ? warnings : undefined,
			});
		});
	}
}
