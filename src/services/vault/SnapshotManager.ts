import { createHash } from "node:crypto";
import type { App, TFile } from "obsidian";
import { KeyedQueue } from "src/lib/concurrency/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import { formatDateForTimestamp } from "src/lib/formatting/dateUtils";
import { isTFile } from "src/lib/obsidian/typeguards";
import { normalizeFileNamePiece } from "src/lib/pathing/pathingUtils";
import type KoreaderImporterPlugin from "src/main";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type { CapabilityManager } from "../CapabilityManager";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { NoteIdentityService } from "./NoteIdentityService";

export class SnapshotManager {
	private readonly log;
	private snapshotDir!: string;
	private backupDir!: string;
	private capabilities: CapabilityManager;
	private readonly queue = new KeyedQueue();

	// Lazy ensure snapshot/backups dirs are present
	private ensureDirsOnce: Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> | null = null;

	constructor(
		private app: App,
		_plugin: KoreaderImporterPlugin,
		private fs: FileSystemService,
		private loggingService: LoggingService,
		private fmService: FrontmatterService,
		private identity: NoteIdentityService,
		capabilities?: CapabilityManager,
	) {
		// Use vault-relative plugin data paths; adapter will handle resolution.
		this.snapshotDir = this.fs.joinPluginDataPath("snapshots");
		this.backupDir = this.fs.joinPluginDataPath("backups");

		this.log = this.loggingService.scoped("SnapshotManager");

		// Backwards-compatible default: assume writable if no capability manager is provided (tests)
		this.capabilities =
			capabilities ??
			({
				ensure: async () => true,
				reportOutcome: () => void 0,
			} as unknown as CapabilityManager);

		// Provide back-reference so NoteIdentityService can eagerly create snapshots on UID change
		this.identity.setSnapshotManager?.(this as any);

		// Listener/cleanup lifecycle removed; UID-change cleanup is now inline post-commit.
	}

	/**
	 * Creates a snapshot of a file for 3-way merge support.
	 * Snapshots represent the state of the file after the last import.
	 * @param targetFile - File to create snapshot for
	 */
	public async createSnapshot(
		targetFile: TFile,
	): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		return this.createSnapshotCore(targetFile, async () => {
			const r = await this.fs.readVaultTextWithRetry(targetFile);
			if (isErr(r)) throw (r as any).error ?? r;
			return r.value;
		});
	}

	/**
	 * Create a snapshot using known content to avoid an immediate vault read.
	 * Returns a Result so callers can abort workflows if snapshotting fails.
	 */
	public async createSnapshotFromContent(
		targetFile: TFile,
		content: string,
		knownUid?: string,
	): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		return this.createSnapshotCore(targetFile, async () => content, knownUid);
	}

	/**
	 * Creates a timestamped backup of a file before modification.
	 * Used as safety measure during merge operations.
	 * @param targetFile - File to backup
	 */
	public async createBackup(
		targetFile: TFile,
	): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		const dirRes = await this.ensureDirs();
		if (isErr(dirRes)) return dirRes;
		return this.createVersion(
			targetFile,
			(f) => this.getBackupPath(f),
			"backup",
		);
	}

	/**
	 * Cleans up old backup files based on a retention policy.
	 * @param retentionDays - The maximum age of backup files to keep, in days.
	 *                        If 0 or less, no backups will be deleted.
	 */
	public async cleanupOldBackups(retentionDays: number): Promise<void> {
		const ok = await this.capabilities.ensure("snapshotsWritable");
		if (!ok) return;
		if (retentionDays <= 0) {
			this.log.info("Backup cleanup skipped (retention period is disabled).");
			return;
		}

		this.log.info(
			`Starting cleanup of backups older than ${retentionDays} days...`,
		);
		const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
		let deletedCount = 0;

		try {
			const scan = await this.fs.getFilesInFolder(this.backupDir, {
				extensions: ["md"],
				recursive: true,
			});
			const { files } = scan; // getFilesInFolder returns FolderScanResult directly
			for (const file of files) {
				const statsTime = file.stat.mtime;
				if (statsTime < cutoffTime) {
					// eslint-disable-next-line no-await-in-loop
					const rm = await this.fs.removeVaultPath(file.path);
					if (!isErr(rm)) {
						this.log.info(`Deleted old backup: ${file.path}`);
						deletedCount++;
					}
				}
			}
		} catch (dirError) {
			this.log.error(
				`Failed to read backup directory for cleanup: ${this.backupDir}`,
				dirError,
			);
			return; // Stop if we can't even read the directory
		}

		if (deletedCount > 0) {
			this.log.info(
				`Cleanup complete. Deleted ${deletedCount} old backup file(s).`,
			);
		} else {
			this.log.info("Cleanup complete. No old backups found to delete.");
		}
	}

	private generateSnapshotFileNameForUid(uid: string): string {
		return `${uid}.md`;
	}

	private getSnapshotPathForUid(uid: string): string {
		const snapshotFileName = this.generateSnapshotFileNameForUid(uid);
		return this.fs.joinVaultPath(this.snapshotDir, snapshotFileName);
	}

	private snapshotPathKeyFor(uid: string): string {
		return `snapshot:${this.getSnapshotPathForUid(uid)}`;
	}

	private getBackupPath(targetFile: TFile): string {
		const timestamp = formatDateForTimestamp();
		const safeBaseName = normalizeFileNamePiece(targetFile.basename).slice(
			0,
			50,
		);
		const pathHash = createHash("sha1")
			.update(targetFile.path)
			.digest("hex")
			.slice(0, 8);
		const backupFileName = `${safeBaseName}-${pathHash}-${timestamp}.md`;
		return this.fs.joinVaultPath(this.backupDir, backupFileName);
	}

	private async createVersion(
		targetFile: TFile,
		getPath: (file: TFile) => string,
		purpose: "snapshot" | "backup",
	): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		const writable = await this.capabilities.ensure("snapshotsWritable", {
			notifyOnce: true,
		});
		if (!writable)
			return err({
				kind: "CapabilityDenied",
				message: "snapshotsWritable=false",
			});

		const versionPath = getPath(targetFile);
		// Ensure the file still exists right before reading to avoid race conditions
		const abs = this.app.vault.getAbstractFileByPath(targetFile.path);
		if (!isTFile(abs)) {
			this.log.warn(
				`File ${targetFile.path} was deleted before ${purpose} could be created.`,
			);
			return err({
				kind: "NotFound",
				message: `File missing before ${purpose} creation`,
			});
		}
		try {
			const r = await this.fs.readVaultTextWithRetry(targetFile);
			if (isErr(r)) throw (r as any).error ?? r;
			const content = r.value;
			const w = await this.writeText(versionPath, content);
			if (isErr(w)) {
				this.log.error(
					`Failed to create ${purpose} for ${targetFile.path}`,
					w.error,
				);
				return err({
					kind: "IO",
					message: `Failed to create ${purpose} for ${targetFile.path}`,
					cause: w.error,
				});
			}
			this.log.info(
				`Created ${purpose} for ${targetFile.path} at ${versionPath}`,
			);
			return ok(void 0);
		} catch (error) {
			this.log.error(
				`Failed to create ${purpose} for ${targetFile.path}`,
				error,
			);
			return err({
				kind: "IO",
				message: `Failed to create ${purpose} for ${targetFile.path}`,
				cause: error,
			});
		}
	}

	// Serialize per-snapshot path
	private withSnapshotLock<T>(uid: string, task: () => Promise<T>): Promise<T> {
		const key = this.snapshotPathKeyFor(uid);
		return this.queue.run(key, task);
	}

	private async writeSnapshotById(
		uid: string,
		bodyContent: string,
	): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		const target = this.getSnapshotPathForUid(uid);
		const hash = this.sha256Hex(bodyContent);
		const composed = this.composeSnapshotContent(hash, bodyContent);
		const w = await this.writeText(target, composed);
		if (isErr(w)) {
			return err({
				kind: "IO",
				message: `Failed to write snapshot for UID ${uid}`,
				cause: w.error,
			});
		}
		return ok(void 0);
	}

	private ensureDirs(): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		if (!this.ensureDirsOnce) {
			this.ensureDirsOnce = (async () => {
				try {
					await this.fs.ensureVaultFolder(this.snapshotDir);
					await this.fs.ensureVaultFolder(this.backupDir);
					return ok(void 0);
				} catch (e) {
					this.log.error("Failed to ensure snapshot/backup directories", e);
					return err({
						kind: "IO",
						message: "Failed to ensure snapshot/backup directories",
						cause: e,
					});
				}
			})();
		}
		return this.ensureDirsOnce;
	}

	/** Normalize line endings to LF for stable hashing across platforms. */
	private normalizeEol(s: string): string {
		return s.replace(/\r\n?/g, "\n");
	}

	private sha256Hex(text: string): string {
		const normalized = this.normalizeEol(text);
		return createHash("sha256").update(normalized, "utf8").digest("hex");
	}

	// Compose a minimal snapshot document with integrity metadata
	private composeSnapshotContent(hash: string, body: string): string {
		const normalizedBody = this.normalizeEol(body);
		const header = `---\nkohl-snapshot:\n  v: 1\n  sha256: ${hash}\n---\n\n`;
		return `${header}${normalizedBody}`;
	}

	/** Consolidated snapshot creation logic used by both public entrypoints. */
	private async createSnapshotCore(
		targetFile: TFile,
		contentProvider: () => Promise<string>,
		knownUid?: string,
	): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		const allowed = await this.capabilities.ensure("snapshotsWritable", {
			notifyOnce: true,
		});
		if (!allowed)
			return err({
				kind: "CapabilityDenied",
				message: "snapshotsWritable=false",
			} as any);
		const dirRes = await this.ensureDirs();
		if (isErr(dirRes)) return dirRes;
		const uid = knownUid ?? (await this.identity.ensureId(targetFile));
		return this.withSnapshotLock(uid, async () => {
			// Ensure the file still exists to avoid read-after-delete
			const abs = this.app.vault.getAbstractFileByPath(targetFile.path);
			if (!isTFile(abs)) {
				this.log.warn(
					`File ${targetFile.path} was deleted before snapshot could be created.`,
				);
				return err({
					kind: "NotFound",
					message: "Target file missing during snapshot",
				} as any);
			}
			const content = await contentProvider();
			const writeRes = await this.writeSnapshotById(uid, content);
			if (isErr(writeRes)) {
				this.log.warn(
					`[SnapshotManager] Snapshot write failed for ${targetFile.path}`,
					writeRes.error,
				);
				return writeRes;
			}
			return writeRes;
		});
	}

	private extractSnapshotMeta(rawContent: string): {
		metaSha: string | null;
		body: string;
	} {
		try {
			const parsed = this.fmService.parseContent(rawContent);
			const fm = parsed.frontmatter as any;
			const meta = fm?.["kohl-snapshot"] as
				| { v?: number; sha256?: string }
				| undefined;
			const metaSha = typeof meta?.sha256 === "string" ? meta.sha256 : null;
			return { metaSha, body: parsed.body };
		} catch {
			return { metaSha: null, body: rawContent };
		}
	}

	// Read snapshot by UID with integrity verification
	public async readSnapshotById(
		uid: string,
	): Promise<
		Result<string, { kind: string; message?: string; cause?: unknown }>
	> {
		const snapshotPath = this.getSnapshotPathForUid(uid);
		const r = await this.fs.readVaultText(snapshotPath);
		if (isErr(r))
			return err({
				kind: "IO",
				message: `Failed to read ${snapshotPath}`,
				cause: r.error,
			});
		const { metaSha, body } = this.extractSnapshotMeta(r.value);
		if (!metaSha) return ok(body);
		const computed = this.sha256Hex(body);
		if (computed !== metaSha) {
			return err({
				kind: "SNAPSHOT_INTEGRITY_FAILED",
				message: "Snapshot integrity check failed",
				cause: { path: snapshotPath },
			} as any);
		}
		return ok(body);
	}

	/**
	 * One-time migration helper: move legacy path-hash snapshot to UID-based snapshot.
	 * - If UID snapshot exists: remove legacy if present and return.
	 * - Else if legacy exists: rewrite to UID snapshot with integrity header, then remove legacy.
	 * - Else: create baseline snapshot from current file content.
	 */
	public async migrateLegacySnapshotForFile(
		file: TFile,
		uid: string,
	): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		// Backwards compatibility wrapper; delegate to simplified single-file migration
		return this.migrateSingleLegacySnapshot(file, uid);
	}

	public async removeSnapshotById(
		uid: string,
	): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		// Serialize per-UID to avoid races with any other operations touching this snapshot file.
		return this.withSnapshotLock(uid, async () => {
			const snapshotPath = this.getSnapshotPathForUid(uid);
			if (await this.fs.vaultExists(snapshotPath)) {
				const res = await this.fs.removeVaultPath(snapshotPath);
				if (isErr(res)) {
					this.log.warn(`Failed to remove snapshot for UID ${uid}`, res.error);
					return err({
						kind: "IO",
						message: `Failed to remove ${snapshotPath}`,
						cause: res.error,
					});
				} else {
					this.log.info(`Removed snapshot for UID ${uid}`);
				}
			}
			return ok(void 0);
		});
	}

	/**
	 * Simplified migration: move a single legacy snapshot (path-hash based) to UID-based snapshot.
	 * - If legacy doesn't exist: no-op.
	 * - If new exists: delete legacy and return.
	 * - Else: rewrite with integrity header to UID path, then delete legacy.
	 */
	public async migrateSingleLegacySnapshot(
		file: TFile,
		uid: string,
	): Promise<
		Result<void, { kind: string; message?: string; cause?: unknown }>
	> {
		const newPath = this.getSnapshotPathForUid(uid);
		const legacyHash = createHash("sha1").update(file.path).digest("hex");
		const legacyPath = this.fs.joinVaultPath(
			this.snapshotDir,
			`${legacyHash}.md`,
		);

		try {
			const legacyExists = await this.fs.vaultExists(legacyPath);
			if (!legacyExists) return ok(void 0);

			if (await this.fs.vaultExists(newPath)) {
				const rm1 = await this.fs.removeVaultPath(legacyPath);
				void rm1; // best-effort; ignore errors
				return ok(void 0);
			}

			const r = await this.fs.readVaultText(legacyPath);
			if (isErr(r)) {
				return err({
					kind: "IO",
					message: `Failed to read legacy snapshot ${legacyPath}`,
					cause: r.error,
				});
			}
			const w = await this.writeSnapshotById(uid, r.value);
			if (isErr(w)) return w;
			const rm2 = await this.fs.removeVaultPath(legacyPath);
			void rm2; // best-effort cleanup
			return ok(void 0);
		} catch (e) {
			this.log.warn("migrateSingleLegacySnapshot failed", {
				file: file.path,
				e,
			});
			return err({
				kind: "IO",
				message: "migrateSingleLegacySnapshot failed",
				cause: e,
			});
		}
	}

	// Write UTF-8 text via FileSystemService using atomic write.
	private async writeText(vaultPath: string, content: string) {
		return this.fs.writeVaultTextAtomic(vaultPath, content);
	}
}
