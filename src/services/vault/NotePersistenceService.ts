import type { App, TFile } from "obsidian";
import {
	extractUidFromFrontmatter,
	generateUid as genUid,
	updateUidFrontmatter,
	validateUid,
} from "src/core/uidRules";
import { KeyedQueue, runPool } from "src/lib/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type {
	AppFailure,
	CapabilityFailure,
	FileSystemFailure,
} from "src/lib/errors";
import {
	composeSnapshotContent,
	computeSnapshotHash,
	generateBackupFileName,
	legacySnapshotPathFor,
	type SnapshotError,
	snapshotErrors,
	snapshotPathForUid,
	verifySnapshotIntegrity,
} from "src/lib/snapshotCore";
import type { CapabilityManager } from "../CapabilityManager";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { FrontmatterService } from "../parsing/FrontmatterService";

// NEW: A consolidated error type for all persistence operations.
type NotePersistenceFailure =
	| SnapshotError
	| CapabilityFailure
	| FileSystemFailure;

/**
 * A cohesive service responsible for a note's persistent state, including its
 * unique identity (kohl-uid) and historical snapshots for 3-way merging.
 */
export class NotePersistenceService {
	private readonly log;
	private readonly snapshotDir: string;
	private readonly backupDir: string;
	private readonly queue = new KeyedQueue();

	/**
	 * Concurrency model:
	 * - A per-file-path lock (`withFileLock`) serializes high-level mutations on a note.
	 * - Per-UID snapshot locks (`withSnapshotLock`/`withTwoSnapshotLocks`) serialize I/O on snapshot files.
	 *   Dual UID locks are acquired in a stable, sorted order to avoid deadlocks.
	 */
	constructor(
		private readonly app: App,
		private readonly fmService: FrontmatterService,
		private readonly fs: FileSystemService,
		private readonly loggingService: LoggingService,
		private readonly capabilities: CapabilityManager,
	) {
		this.log = this.loggingService.scoped("NotePersistenceService");
		this.snapshotDir = this.fs.joinPluginDataPath("snapshots");
		this.backupDir = this.fs.joinPluginDataPath("backups");
	}

	// NEW: per-file lock to serialize operations on a single note.
	private withFileLock<T>(
		fileOrPath: TFile | string,
		task: () => Promise<T>,
	): Promise<T> {
		const path = typeof fileOrPath === "string" ? fileOrPath : fileOrPath.path;
		return this.queue.run(`file:${path}`, task);
	}

	// --- Identity Management ---

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

	/**
	 * Atomically assigns a new UID to a file and migrates its snapshot baseline
	 * using a copy-first prepare–commit–rollback pattern.
	 *
	 * @param file The file to re-assign.
	 * @param oldUid The previous UID, if known.
	 * @param opts.targetUid Optional stable UID for idempotent retries across crashes.
	 */
	public async assignNewId(
		file: TFile,
		oldUid?: string,
		opts?: { targetUid?: string },
	): Promise<Result<string, AppFailure>> {
		return this.withFileLock(file, async () => {
			const newUid = opts?.targetUid ?? this.generateUid();

			if (!oldUid || oldUid === newUid) {
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

	// --- Snapshot & Backup Management ---

	public async createSnapshot(
		targetFile: TFile,
		uid: string,
	): Promise<Result<void, NotePersistenceFailure>> {
		const contentResult = await this.fs.readVaultTextWithRetry(targetFile);
		if (isErr(contentResult)) {
			return err(
				snapshotErrors.readFailed(
					`Failed to read for snapshot: ${targetFile.path}`,
					contentResult.error,
				),
			);
		}
		return this.createSnapshotFromContent(uid, contentResult.value);
	}

	public async createSnapshotFromContent(
		uid: string,
		content: string,
	): Promise<Result<void, NotePersistenceFailure>> {
		return this.createSnapshotCore(null, uid, async () => content);
	}

	public async readSnapshotById(
		uid: string,
	): Promise<Result<string, SnapshotError | FileSystemFailure>> {
		return this.readSnapshot(uid);
	}

	public async createBackup(
		targetFile: TFile,
	): Promise<Result<void, NotePersistenceFailure>> {
		const writable = await this.capabilities.ensure("snapshotsWritable", {
			notifyOnce: true,
		});
		if (!writable) {
			return err({
				kind: "CAPABILITY_DENIED",
				capability: "snapshotsWritable",
				message: "snapshotsWritable capability is unavailable.",
			});
		}

		const backupFileName = generateBackupFileName(
			targetFile.basename,
			targetFile.path,
		);
		const backupPath = this.fs.joinVaultPath(this.backupDir, backupFileName);

		try {
			const r = await this.fs.readVaultTextWithRetry(targetFile);
			if (isErr(r)) {
				return err(
					snapshotErrors.readFailed(`Failed to read for backup`, r.error),
				);
			}

			const w = await this.fs.writeVaultTextAtomic(backupPath, r.value);
			if (isErr(w)) {
				return err(
					snapshotErrors.writeFailed(`Failed to create backup`, w.error),
				);
			}

			this.log.info(`Created backup for ${targetFile.path} at ${backupPath}`);
			return ok(undefined);
		} catch (error) {
			this.log.error(`Unexpected error creating backup`, error);
			return err(snapshotErrors.writeFailed(`Failed to create backup`, error));
		}
	}

	public async cleanupOldBackups(retentionDays: number): Promise<void> {
		const ok = await this.capabilities.ensure("snapshotsWritable");
		if (!ok || retentionDays <= 0) {
			return;
		}

		this.log.info(`Cleaning backups older than ${retentionDays} days...`);
		const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

		try {
			const { files: filesToDelete } = await this.fs.getFilesInFolder(
				this.backupDir,
				{ extensions: ["md"], recursive: true },
			);

			const oldFiles = filesToDelete.filter(
				(file) => file.stat.mtime < cutoffTime,
			);
			if (oldFiles.length === 0) return;

			const concurrency =
				typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4;
			const results = await runPool(
				oldFiles,
				concurrency,
				async (file: TFile) => !isErr(await this.fs.removeVaultPath(file.path)),
			);
			const deletedCount = results.filter(Boolean).length;
			this.log.info(`Cleanup complete. Deleted ${deletedCount} old backup(s).`);
		} catch (e) {
			this.log.error(`Failed to clean up old backups`, e);
		}
	}

	public async migrateSingleLegacySnapshot(
		file: TFile,
		uid: string,
	): Promise<Result<void, NotePersistenceFailure>> {
		const legacyPath = legacySnapshotPathFor(this.snapshotDir, file.path);

		return this.withSnapshotLock(uid, async () => {
			try {
				const legacyExistsRes = await this.fs.vaultExists(legacyPath);
				if (isErr(legacyExistsRes) || !legacyExistsRes.value) {
					return ok(undefined);
				}

				if (await this.snapshotExists(uid)) {
					void (await this.fs.removeVaultPath(legacyPath));
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

				void (await this.fs.removeVaultPath(legacyPath));
				return ok(undefined);
			} catch (e) {
				this.log.warn("migrateSingleLegacySnapshot failed", {
					file: file.path,
					e,
				});
				return err(
					snapshotErrors.migrationFailed(
						"migrateSingleLegacySnapshot failed",
						e,
					),
				);
			}
		});
	}

	// --- Private Implementation ---

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
			await this.fmService.editFrontmatter(file, (fm) => {
				const updated = updateUidFrontmatter(
					(fm as Record<string, unknown>) ?? {},
					newUid,
					oldUid,
				);
				Object.assign(fm, updated);
			});
			return ok(newUid);
		} catch (e) {
			this.log.error("updateFrontmatterUid failed", {
				path: file.path,
				error: e,
			});
			return err(e as AppFailure);
		}
	}

	private async writeSnapshot(
		uid: string,
		body: string,
	): Promise<Result<void, NotePersistenceFailure>> {
		const allowed = await this.capabilities.ensure("snapshotsWritable", {
			notifyOnce: true,
		});
		if (!allowed) {
			return err({
				kind: "CAPABILITY_DENIED",
				capability: "snapshotsWritable",
				message: "Snapshots are disabled or the data folder is not writable.",
			});
		}
		const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
		const hash = computeSnapshotHash(body);
		const content = composeSnapshotContent(hash, body);
		const w = await this.fs.writeVaultTextAtomic(path, content);
		return isErr(w)
			? err(
					snapshotErrors.writeFailed(
						`Failed to write snapshot for UID ${uid}`,
						w.error,
					),
				)
			: ok(undefined);
	}

	private async readSnapshot(
		uid: string,
	): Promise<Result<string, SnapshotError | FileSystemFailure>> {
		const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
		const r = await this.fs.readVaultText(path);
		if (isErr(r)) {
			const e = r.error as any;
			return e?.kind === "NotFound"
				? err(snapshotErrors.snapshotMissing(`No snapshot at ${path}`))
				: err(snapshotErrors.readFailed(`Failed to read ${path}`, r.error));
		}
		return verifySnapshotIntegrity(r.value);
	}

	private async removeSnapshot(
		uid: string,
	): Promise<Result<void, SnapshotError | FileSystemFailure>> {
		const path = snapshotPathForUid(this.snapshotDir, uid).fullPath;
		const res = await this.fs.removeVaultPath(path);
		return isErr(res)
			? err(snapshotErrors.writeFailed(`Failed to remove ${path}`, res.error))
			: ok(undefined);
	}

	private async renameSnapshotFile(
		oldUid: string,
		newUid: string,
	): Promise<Result<void, SnapshotError | FileSystemFailure>> {
		const from = snapshotPathForUid(this.snapshotDir, oldUid).fullPath;
		const to = snapshotPathForUid(this.snapshotDir, newUid).fullPath;
		const mv = await this.fs.renameVaultPathAtomic(from, to);
		if (isErr(mv)) {
			return err(
				snapshotErrors.writeFailed(
					`Failed to rename snapshot ${from} -> ${to}`,
					mv.error,
				),
			);
		}
		return ok(undefined);
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
}
