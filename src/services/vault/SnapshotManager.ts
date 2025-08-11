import { createHash } from "node:crypto";
import path from "node:path";
import { type App, Notice, TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { KeyedQueue } from "src/utils/concurrency";
import { normalizeFileNamePiece } from "src/utils/formatUtils";
import type { CapabilityManager } from "../CapabilityManager";
import {
	FileSystemError,
	FileSystemErrorCode,
	type FileSystemService,
} from "../FileSystemService";
import type { LoggingService } from "../LoggingService";

export class SnapshotManager {
	private readonly log;
	private snapshotDir!: string;
	private backupDir!: string;
	private capabilities: CapabilityManager;
	private readonly queue = new KeyedQueue();

	constructor(
		private app: App,
		_plugin: KoreaderImporterPlugin,
		private fs: FileSystemService,
		private loggingService: LoggingService,
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
	}

	/**
	 * Creates a snapshot of a file for 3-way merge support.
	 * Snapshots represent the state of the file after the last import.
	 * @param targetFile - File to create snapshot for
	 */
	public async createSnapshot(targetFile: TFile): Promise<void> {
		const ok = await this.capabilities.ensure("snapshotsWritable", {
			notifyOnce: true,
		});
		if (!ok) return;
		await this.withSnapshotLock(targetFile.path, async () => {
			// Ensure the file still exists to avoid read-after-delete
			const abs = this.app.vault.getAbstractFileByPath(targetFile.path);
			if (!(abs instanceof TFile)) {
				this.log.warn(
					`File ${targetFile.path} was deleted before snapshot could be created.`,
				);
				return;
			}
			const content = await this.readWithRetry(targetFile);
			try {
				await this.writeSnapshot(targetFile, content);
			} catch (error) {
				this.log.warn(
					`[SnapshotManager] Snapshot write failed for ${targetFile.path}; continuing without snapshot`,
					error,
				);
				new Notice(
					`Warning: Could not update snapshot for ${targetFile.basename}. Future merges may be less accurate.`,
				);
			}
		});
	}

	/**
	 * Create a snapshot using known content to avoid an immediate vault read.
	 */
	public async createSnapshotFromContent(
		targetFile: TFile,
		content: string,
	): Promise<void> {
		const ok = await this.capabilities.ensure("snapshotsWritable", {
			notifyOnce: true,
		});
		if (!ok) return;
		await this.withSnapshotLock(targetFile.path, async () => {
			try {
				await this.writeSnapshot(targetFile, content);
			} catch (error) {
				this.log.warn(
					`[SnapshotManager] Snapshot write failed for ${targetFile.path}; continuing without snapshot`,
					error,
				);
				new Notice(
					`Warning: Could not update snapshot for ${targetFile.basename}. Future merges may be less accurate.`,
				);
			}
		});
	}

	/**
	 * Creates a timestamped backup of a file before modification.
	 * Used as safety measure during merge operations.
	 * @param targetFile - File to backup
	 */
	public async createBackup(targetFile: TFile): Promise<void> {
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
			const { files } = await this.fs.getFilesInFolder(this.backupDir, {
				extensions: ["md"],
				recursive: true,
			});
			for (const file of files) {
				const statsTime = file.stat.mtime;
				if (statsTime < cutoffTime) {
					// eslint-disable-next-line no-await-in-loop
					await this.app.vault.delete(file);
					this.log.info(`Deleted old backup: ${file.path}`);
					deletedCount++;
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

	/**
	 * Retrieves the content of a file's snapshot.
	 * Used as the base version for 3-way merges.
	 * @param targetFile - File to get snapshot for
	 * @returns Snapshot content or null if not found
	 */
	public async getSnapshotContent(targetFile: TFile): Promise<string | null> {
		const ok = await this.capabilities.ensure("snapshotsWritable");
		if (!ok) return null;
		const snapshotPath = this.getSnapshotPath(targetFile);
		try {
			// Prefer reading via vault if a TFile exists, to align with tests that spy on vault.read
			const abs = this.app.vault.getAbstractFileByPath(snapshotPath);
			if (abs instanceof TFile) {
				return await this.app.vault.read(abs);
			}
			return await this.fs.readVaultText(snapshotPath);
		} catch (error) {
			if (error instanceof FileSystemError && error.isNotFound) {
				return null; // missing snapshot is OK
			}
			this.log.error(`Failed to read snapshot for ${targetFile.path}`, error);
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

	private getSnapshotPath(targetFile: TFile): string {
		const hash = createHash("sha1").update(targetFile.path).digest("hex");
		const snapshotFileName = `${hash}.md`;
		return path.join(this.snapshotDir, snapshotFileName);
	}

	private snapshotPathFor(vaultPath: string): string {
		const hash = createHash("sha1").update(vaultPath).digest("hex");
		return path.join(this.snapshotDir, `${hash}.md`);
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
		try {
			// Ensure the file still exists right before reading to avoid race conditions
			const abs = this.app.vault.getAbstractFileByPath(targetFile.path);
			if (!(abs instanceof TFile)) {
				this.log.warn(
					`File ${targetFile.path} was deleted before ${purpose} could be created.`,
				);
				return;
			}
			const content = await this.app.vault.read(targetFile);
			await this.writeText(versionPath, content);
			this.log.info(
				`Created ${purpose} for ${targetFile.path} at ${versionPath}`,
			);
		} catch (error) {
			this.log.error(
				`Failed to create ${purpose} for ${targetFile.path}`,
				error,
			);
			// Snapshot failures should not block import; backups are stricter
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
	private withSnapshotLock<T>(
		vaultPath: string,
		task: () => Promise<T>,
	): Promise<T> {
		const key = `snapshot:${this.snapshotPathFor(vaultPath)}`;
		return this.queue.run(key, task);
	}

	private async readWithRetry(file: TFile): Promise<string> {
		const maxAttempts = 5;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				return await this.app.vault.read(file);
			} catch (e) {
				const msg = String((e as Error)?.message || "");
				const transient = /ENOENT|busy|locked|EPERM|EACCES/i.test(msg);
				if (!transient || attempt === maxAttempts - 1) throw e;
				await this.backoff(attempt);
			}
		}
		return ""; // unreachable
	}

	private async writeSnapshot(file: TFile, content: string): Promise<void> {
		const target = this.getSnapshotPath(file);
		const maxAttempts = 6;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				await this.writeText(target, content);
				return;
			} catch (e) {
				const code = e instanceof FileSystemError ? e.code : undefined;
				const transient =
					code === FileSystemErrorCode.AlreadyExists ||
					code === FileSystemErrorCode.NotFound ||
					code === FileSystemErrorCode.Permission;
				if (!transient || attempt === maxAttempts - 1) {
					this.log.error(
						`[SnapshotManager] Failed to write snapshot ${target}`,
						e,
					);
					throw e;
				}
				await this.backoff(attempt);
			}
		}
	}

	// Write UTF-8 text via FileSystemService. Prefer atomic method; fall back for tests/mocks.
	private async writeText(vaultPath: string, content: string): Promise<void> {
		const fsAny = this.fs as any;
		if (typeof fsAny.writeVaultTextAtomic === "function") {
			return fsAny.writeVaultTextAtomic(vaultPath, content);
		}
		if (typeof fsAny.writeVaultFile === "function") {
			return fsAny.writeVaultFile(vaultPath, content);
		}
		throw new Error(
			"FileSystemService missing write method (writeVaultTextAtomic or writeVaultFile)",
		);
	}

	private async backoff(attempt: number): Promise<void> {
		const base = 50; // ms
		const delay =
			Math.min(1000, base * 2 ** attempt) + Math.floor(Math.random() * 50);
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
}
