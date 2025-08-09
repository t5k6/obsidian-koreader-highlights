import { createHash } from "node:crypto";
import path from "node:path";
import { type App, TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { normalizeFileNamePiece } from "src/utils/formatUtils";
import type { CapabilityManager } from "../CapabilityManager";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";

export class SnapshotManager {
	private readonly log;
	private snapshotDir: string;
	private backupDir: string;
	private capabilities: CapabilityManager;

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
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
		await this.createVersion(
			targetFile,
			(f) => this.getSnapshotPath(f),
			"snapshot",
		);
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
			const abs = this.app.vault.getAbstractFileByPath(snapshotPath);
			if (abs instanceof TFile) {
				return await this.app.vault.read(abs);
			}
			return null;
		} catch (error) {
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
			await this.fs.writeVaultFile(versionPath, content);
			this.log.info(
				`Created ${purpose} for ${targetFile.path} at ${versionPath}`,
			);
		} catch (error) {
			this.log.error(
				`Failed to create ${purpose} for ${targetFile.path}`,
				error,
			);
			throw error;
		}
	}
}
