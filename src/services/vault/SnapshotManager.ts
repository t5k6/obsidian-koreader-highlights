import { createHash } from "node:crypto";
import path from "node:path";
import { type App, Notice, TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { Mutex } from "src/utils/concurrency";
import { normalizeFileNamePiece } from "src/utils/formatUtils";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";

export class SnapshotManager {
	private readonly SCOPE = "SnapshotManager";
	private snapshotDir: string;
	private backupDir: string;
	// Mutex to serialize capability checks and avoid race conditions
	private capabilityCheckMutex = new Mutex();

	// Degraded-mode capability for snapshots/backups
	private writableState: "unknown" | "writable" | "readonly" = "unknown";
	private lastCapabilityCheck = 0;
	private readonly CAPABILITY_TTL_MS = 5 * 60 * 1000; // 5 minutes
	private hasShownReadonlyNotice = false;

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private fs: FileSystemService,
		private loggingService: LoggingService,
	) {
		// Use vault-relative plugin data paths; adapter will handle resolution.
		this.snapshotDir = this.fs.joinPluginDataPath("snapshots");
		this.backupDir = this.fs.joinPluginDataPath("backups");
	}

	/**
	 * Creates a snapshot of a file for 3-way merge support.
	 * Snapshots represent the state of the file after the last import.
	 * @param targetFile - File to create snapshot for
	 */
	public async createSnapshot(targetFile: TFile): Promise<void> {
		if (!(await this.ensureCapability())) return;
		const snapshotPath = this.getSnapshotPath(targetFile);
		try {
			const content = await this.app.vault.read(targetFile);
			await this.fs.writeVaultFile(snapshotPath, content);
			this.loggingService.info(
				this.SCOPE,
				`Created snapshot for ${targetFile.path} at ${snapshotPath}`,
			);
		} catch (error) {
			this.loggingService.error(
				this.SCOPE,
				`Failed to write snapshot for ${targetFile.path}`,
				error,
			);
			throw error;
		}
	}

	/**
	 * Creates a timestamped backup of a file before modification.
	 * Used as safety measure during merge operations.
	 * @param targetFile - File to backup
	 */
	public async createBackup(targetFile: TFile): Promise<void> {
		if (!(await this.ensureCapability())) return;
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
		const backupPath = path.join(this.backupDir, backupFileName);

		try {
			const content = await this.app.vault.read(targetFile);
			await this.fs.writeVaultFile(backupPath, content);
			this.loggingService.info(
				this.SCOPE,
				`Created backup for ${targetFile.path} at ${backupPath}`,
			);
		} catch (error) {
			this.loggingService.error(
				this.SCOPE,
				`Failed to create backup for ${targetFile.path}`,
				error,
			);
			throw error;
		}
	}

	/**
	 * Cleans up old backup files based on a retention policy.
	 * @param retentionDays - The maximum age of backup files to keep, in days.
	 *                        If 0 or less, no backups will be deleted.
	 */
	public async cleanupOldBackups(retentionDays: number): Promise<void> {
		if (!(await this.ensureCapability())) return;
		if (retentionDays <= 0) {
			this.loggingService.info(
				this.SCOPE,
				"Backup cleanup skipped (retention period is disabled).",
			);
			return;
		}

		this.loggingService.info(
			this.SCOPE,
			`Starting cleanup of backups older than ${retentionDays} days...`,
		);
		const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
		let deletedCount = 0;

		try {
			const { files } = await this.fs.getFilesInFolder(this.backupDir, {
				extensions: ["md"],
				recursive: true,
			});
			for (const file of files) {
				const statsTime = file.stat.mtime;
				if (statsTime < cutoffTime) {
					// eslint-disable-next-line no-await-in-loop
					await this.app.vault.delete(file);
					this.loggingService.info(
						this.SCOPE,
						`Deleted old backup: ${file.path}`,
					);
					deletedCount++;
				}
			}
		} catch (dirError) {
			this.loggingService.error(
				this.SCOPE,
				`Failed to read backup directory for cleanup: ${this.backupDir}`,
				dirError,
			);
			return; // Stop if we can't even read the directory
		}

		if (deletedCount > 0) {
			this.loggingService.info(
				this.SCOPE,
				`Cleanup complete. Deleted ${deletedCount} old backup file(s).`,
			);
		} else {
			this.loggingService.info(
				this.SCOPE,
				"Cleanup complete. No old backups found to delete.",
			);
		}
	}

	/**
	 * Retrieves the content of a file's snapshot.
	 * Used as the base version for 3-way merges.
	 * @param targetFile - File to get snapshot for
	 * @returns Snapshot content or null if not found
	 */
	public async getSnapshotContent(targetFile: TFile): Promise<string | null> {
		if (!(await this.ensureCapability())) return null;
		const snapshotPath = this.getSnapshotPath(targetFile);
		try {
			const abs = this.app.vault.getAbstractFileByPath(snapshotPath);
			if (abs instanceof TFile) {
				return await this.app.vault.read(abs);
			}
			return null;
		} catch (error) {
			this.loggingService.error(
				this.SCOPE,
				`Failed to read snapshot for ${targetFile.path}`,
				error,
			);
			return null;
		}
	}

	/**
	 * Generates a snapshot filename based on the original file path.
	 * Uses SHA1 hash to ensure unique, consistent naming.
	 * @param filePath - Original file path
	 * @returns Snapshot filename with .md extension
	 */
	static generateSnapshotFileName(filePath: string): string {
		const hash = createHash("sha1").update(filePath).digest("hex");
		return `${hash}.md`;
	}

	/**
	 * Public-facing check to determine if snapshots and backups are currently writable.
	 * This method is safe to call from other services.
	 * @returns A promise resolving to true if write operations are likely to succeed.
	 */
	public async isWritable(): Promise<boolean> {
		return this.ensureCapability();
	}

	private getSnapshotPath(targetFile: TFile): string {
		const hash = createHash("sha1").update(targetFile.path).digest("hex");
		const snapshotFileName = `${hash}.md`;
		return path.join(this.snapshotDir, snapshotFileName);
	}

	private async ensureCapability(): Promise<boolean> {
		// If directories were not set (e.g., mobile), short-circuit as readonly
		if (!this.snapshotDir || !this.backupDir) {
			this.writableState = "readonly";
			return false;
		}

		// Fast path: if known and fresh, return without locking
		const now = Date.now();
		if (
			this.writableState !== "unknown" &&
			now - this.lastCapabilityCheck < this.CAPABILITY_TTL_MS
		) {
			return this.writableState === "writable";
		}

		// Serialize the probe to avoid races across concurrent callers
		return this.capabilityCheckMutex.lock(async () => {
			// Double-check after acquiring the lock in case another caller updated it
			const innerNow = Date.now();
			if (
				this.writableState !== "unknown" &&
				innerNow - this.lastCapabilityCheck < this.CAPABILITY_TTL_MS
			) {
				return this.writableState === "writable";
			}

			this.lastCapabilityCheck = Date.now();
			const probePath = this.fs.joinPluginDataPath(
				"snapshots",
				".__snap_probe__",
			);

			// Defensive cleanup: remove a leftover probe from a previous run to ensure idempotency
			try {
				const leftover = this.app.vault.getAbstractFileByPath(probePath);
				if (leftover) {
					await this.app.vault.delete(leftover);
				}
			} catch (cleanupError) {
				this.loggingService.warn(
					this.SCOPE,
					"Could not clean up leftover probe file before capability check. Proceeding.",
					cleanupError,
				);
			}

			try {
				// Make the probe idempotent and specific.
				// First, ensure the parent directories exist. This is crucial.
				await this.fs.ensureVaultFolder(this.snapshotDir);
				await this.fs.ensureVaultFolder(this.backupDir);

				// Attempt to write the file. This is the core test.
				await this.fs.writeVaultFile(probePath, "probe");

				// If write succeeds, immediately clean up (ignore races if someone else deleted it already).
				try {
					const file = this.app.vault.getAbstractFileByPath(probePath);
					if (file) {
						await this.app.vault.delete(file);
					}
				} catch (_) {
					// no-op
				}

				// Only if all steps succeed, we are writable.
				this.writableState = "writable";
				return true;
			} catch (e: unknown) {
				// NOW, we inspect the error. Do NOT assume it's a permission issue.
				// If the error is a FileSystemError and it is NOT a permission error, it's something else we
				// should probably not ignore. For now, we will treat any failure to write as a sign of
				// being in a read-only state, but we log the *actual* error.
				this.writableState = "readonly";
				if (!this.hasShownReadonlyNotice) {
					this.loggingService.warn(
						this.SCOPE,
						"Snapshot/backup capability check failed. Entering read-only mode for this session. See error for details.",
						e, // Log the *actual* error, not a generic message.
					);
					new Notice(
						"KOReader Importer: Snapshots & backups disabled (read-only or other file error).",
						8000,
					);
					this.hasShownReadonlyNotice = true;
				}
				return false;
			}
		});
	}
}
