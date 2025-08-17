import { createHash } from "node:crypto";
import path from "node:path";
import { type App, Notice, TFile } from "obsidian";
import { KeyedQueue } from "src/lib/concurrency/concurrency";
import { err, isErr, ok } from "src/lib/core/result";
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
	private ensureDirsOnce: Promise<void> | null = null;

	private unsubscribeUidChanged: (() => void) | null = null;

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

		// React to UID changes with cleanup-first logic
		this.unsubscribeUidChanged = this.identity.onUidChanged(
			async (_file, oldUid, newUid) => {
				if (!oldUid) return;
				if (oldUid === newUid) return;
				const oldPath = this.getSnapshotPathForUid(oldUid);
				const newPath = this.getSnapshotPathForUid(newUid);
				try {
					const [first, second] = [oldUid, newUid].sort();
					await this.withSnapshotLock(first, async () => {
						await this.withSnapshotLock(second, async () => {
							const newExists = await this.fs.vaultExists(newPath);
							const oldExists = await this.fs.vaultExists(oldPath);

							if (newExists && oldExists) {
								// New snapshot already created eagerly; remove old best-effort
								void this.fs.removeVaultPath(oldPath);
								this.log.info(
									`Cleaned up old snapshot after UID change ${oldUid} -> ${newUid}`,
								);
								return;
							}
							if (!newExists && oldExists) {
								// Fallback: rename old → new
								const res = await this.fs.renameVaultPath(oldPath, newPath);
								if (isErr(res)) {
									this.log.warn("Failed to rename snapshot on UID change", {
										oldUid,
										newUid,
										error: res.error,
									});
									new Notice(
										"Failed to update snapshot for renamed note. Future merges may be affected.",
										7000,
									);
								} else {
									this.log.info(`Renamed snapshot ${oldUid} -> ${newUid}`);
								}
							}
							// If neither exists: nothing to do. A later merge will recreate a baseline.
						});
					});
				} catch (e) {
					this.log.warn("Failed to rename snapshot on UID change", {
						oldUid,
						newUid,
						e,
					});
					new Notice(
						"Failed to update snapshot for renamed note. Future merges may be affected.",
						7000,
					);
				}
			},
		);
	}

	/** Dispose resources (event listeners) to prevent leaks. */
	public dispose(): void {
		try {
			this.unsubscribeUidChanged?.();
		} finally {
			this.unsubscribeUidChanged = null;
		}
	}

	/**
	 * Creates a snapshot of a file for 3-way merge support.
	 * Snapshots represent the state of the file after the last import.
	 * @param targetFile - File to create snapshot for
	 */
	public async createSnapshot(targetFile: TFile): Promise<void> {
		await this.createSnapshotCore(targetFile, async () =>
			this.app.vault.read(targetFile),
		);
	}

	/**
	 * Create a snapshot using known content to avoid an immediate vault read.
	 * Returns a Result so callers can abort workflows if snapshotting fails.
	 */
	public async createSnapshotFromContent(
		targetFile: TFile,
		content: string,
		knownUid?: string,
	): Promise<ReturnType<typeof this.writeSnapshotById>> {
		return this.createSnapshotCore(targetFile, async () => content, knownUid);
	}

	/**
	 * Creates a timestamped backup of a file before modification.
	 * Used as safety measure during merge operations.
	 * @param targetFile - File to backup
	 */
	public async createBackup(targetFile: TFile): Promise<void> {
		await this.ensureDirs();
		await this.createVersion(
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
		return path.join(this.snapshotDir, snapshotFileName);
	}

	private snapshotPathKeyFor(uid: string): string {
		return `snapshot:${this.getSnapshotPathForUid(uid)}`;
	}

	private getBackupPath(targetFile: TFile): string {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const safeBaseName = normalizeFileNamePiece(targetFile.basename).slice(
			0,
			50,
		);
		const pathHash = createHash("sha1")
			.update(targetFile.path)
			.digest("hex")
			.slice(0, 8);
		const backupFileName = `${safeBaseName}-${pathHash}-${timestamp}.md`;
		return path.join(this.backupDir, backupFileName);
	}

	private async createVersion(
		targetFile: TFile,
		getPath: (file: TFile) => string,
		purpose: "snapshot" | "backup",
	): Promise<void> {
		const ok = await this.capabilities.ensure("snapshotsWritable", {
			notifyOnce: true,
		});
		if (!ok) return;

		const versionPath = getPath(targetFile);
		// Ensure the file still exists right before reading to avoid race conditions
		const abs = this.app.vault.getAbstractFileByPath(targetFile.path);
		if (!(abs instanceof TFile)) {
			this.log.warn(
				`File ${targetFile.path} was deleted before ${purpose} could be created.`,
			);
			return;
		}
		try {
			const content = await this.app.vault.read(targetFile);
			const w = await this.writeText(versionPath, content);
			if (isErr(w)) {
				this.log.error(
					`Failed to create ${purpose} for ${targetFile.path}`,
					w.error,
				);
				if (purpose === "snapshot") {
					new Notice(
						`Warning: Could not update snapshot for ${targetFile.basename}. Future merges may be less accurate.`,
					);
					return;
				}
				throw w.error as any;
			}
			this.log.info(
				`Created ${purpose} for ${targetFile.path} at ${versionPath}`,
			);
		} catch (error) {
			this.log.error(
				`Failed to create ${purpose} for ${targetFile.path}`,
				error,
			);
			if (purpose === "snapshot") {
				new Notice(
					`Warning: Could not update snapshot for ${targetFile.basename}. Future merges may be less accurate.`,
				);
				return;
			}
			throw error;
		}
	}

	// Serialize per-snapshot path
	private withSnapshotLock<T>(uid: string, task: () => Promise<T>): Promise<T> {
		const key = this.snapshotPathKeyFor(uid);
		return this.queue.run(key, task);
	}

	private async writeSnapshotById(uid: string, bodyContent: string) {
		const target = this.getSnapshotPathForUid(uid);
		const hash = this.sha256Hex(bodyContent);
		const composed = this.composeSnapshotContent(hash, bodyContent);
		return this.writeText(target, composed);
	}

	private ensureDirs(): Promise<void> {
		if (!this.ensureDirsOnce) {
			this.ensureDirsOnce = (async () => {
				await this.fs.ensureVaultFolder(this.snapshotDir);
				await this.fs.ensureVaultFolder(this.backupDir);
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
	): Promise<ReturnType<typeof this.writeSnapshotById>> {
		const ok = await this.capabilities.ensure("snapshotsWritable", {
			notifyOnce: true,
		});
		if (!ok)
			return err({
				kind: "CapabilityDenied",
				message: "snapshotsWritable=false",
			} as any);
		await this.ensureDirs();
		const uid = knownUid ?? (await this.identity.ensureId(targetFile));
		return this.withSnapshotLock(uid, async () => {
			// Ensure the file still exists to avoid read-after-delete
			const abs = this.app.vault.getAbstractFileByPath(targetFile.path);
			if (!(abs instanceof TFile)) {
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
				new Notice(
					`Warning: Could not update snapshot for ${targetFile.basename}. Future merges may be less accurate.`,
				);
				return writeRes;
			}
			return writeRes;
		});
	}

	// Extracts snapshot meta and returns the body without frontmatter
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
	public async readSnapshotById(uid: string) {
		const snapshotPath = this.getSnapshotPathForUid(uid);
		const r = await this.fs.readVaultText(snapshotPath);
		if (isErr(r)) return r;
		const { metaSha, body } = this.extractSnapshotMeta(r.value);
		if (!metaSha) return ok(body);
		const computed = this.sha256Hex(body);
		if (computed !== metaSha) {
			new Notice("Snapshot integrity check failed. Merge aborted.");
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
	): Promise<void> {
		// Backwards compatibility wrapper; delegate to simplified single-file migration
		return this.migrateSingleLegacySnapshot(file, uid);
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
	): Promise<void> {
		const newPath = this.getSnapshotPathForUid(uid);
		const legacyHash = createHash("sha1").update(file.path).digest("hex");
		const legacyPath = path.join(this.snapshotDir, `${legacyHash}.md`);

		try {
			const legacyExists = await this.fs.vaultExists(legacyPath);
			if (!legacyExists) return;

			if (await this.fs.vaultExists(newPath)) {
				const rm1 = await this.fs.removeVaultPath(legacyPath);
				void rm1; // best-effort; ignore errors
				return;
			}

			const r = await this.fs.readVaultText(legacyPath);
			if (!isErr(r)) {
				await this.writeSnapshotById(uid, r.value);
				const rm2 = await this.fs.removeVaultPath(legacyPath);
				void rm2;
			}
		} catch (e) {
			this.log.warn("migrateSingleLegacySnapshot failed", {
				file: file.path,
				e,
			});
		}
	}

	// Write UTF-8 text via FileSystemService using atomic write.
	private async writeText(vaultPath: string, content: string) {
		return this.fs.writeVaultTextAtomic(vaultPath, content);
	}
}
