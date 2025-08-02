import { createHash } from "node:crypto";
import path from "node:path";
import { type App, normalizePath, type TFile, type Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { logger } from "src/utils/logging";
import type { FileSystemService } from "../FileSystemService";

export class SnapshotManager {
	private snapshotDir: string;
	private backupDir: string;

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private vault: Vault,
		private fs: FileSystemService,
	) {
		const pluginDataDir = `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`;
		this.snapshotDir = normalizePath(`${pluginDataDir}/snapshots`);
		this.backupDir = normalizePath(`${pluginDataDir}/backups`);
	}

	/**
	 * Ensures a directory exists, creating it if necessary.
	 * @param dirPath - Path to the directory
	 */
	private async ensureDir(dirPath: string): Promise<void> {
		try {
			const adapter = this.vault.adapter;
			if (!(await adapter.exists(dirPath))) {
				await adapter.mkdir(dirPath);
				logger.info(`SnapshotManager: Directory created at ${dirPath}`);
			}
		} catch (error) {
			logger.error(
				`SnapshotManager: Failed to create directory: ${dirPath}`,
				error,
			);
			throw new Error(`Failed to ensure directory exists: ${dirPath}`);
		}
	}

	/**
	 * Creates a snapshot of a file for 3-way merge support.
	 * Snapshots represent the state of the file after the last import.
	 * @param targetFile - File to create snapshot for
	 */
	public async createSnapshot(targetFile: TFile): Promise<void> {
		const snapshotPath = this.getSnapshotPath(targetFile);
		try {
			const content = await this.app.vault.read(targetFile);
			await this.fs.writeNodeFile(snapshotPath, content);
			logger.info(
				`SnapshotManager: Created snapshot for ${targetFile.path} at ${snapshotPath}`,
			);
		} catch (error) {
			logger.error(
				`SnapshotManager: Failed to write snapshot for ${targetFile.path}`,
				error,
			);
		}
	}

	/**
	 * Creates a timestamped backup of a file before modification.
	 * Used as safety measure during merge operations.
	 * @param targetFile - File to backup
	 */
	public async createBackup(targetFile: TFile): Promise<void> {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backupFileName = `${targetFile.basename}-${timestamp}.md`;
		const backupPath = path.join(this.backupDir, backupFileName);

		try {
			const content = await this.app.vault.read(targetFile);
			await this.fs.writeNodeFile(backupPath, content);
			logger.info(
				`SnapshotManager: Created backup for ${targetFile.path} at ${backupPath}`,
			);
		} catch (error) {
			logger.error(
				`SnapshotManager: Failed to create backup for ${targetFile.path}`,
				error,
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
		const snapshotPath = this.getSnapshotPath(targetFile);
		try {
			if (await this.fs.nodeFileExists(snapshotPath)) {
				return await this.fs.readNodeFile(snapshotPath);
			}
			return null;
		} catch (error) {
			logger.error(
				`SnapshotManager: Failed to read snapshot for ${targetFile.path}`,
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

	private getSnapshotPath(targetFile: TFile): string {
		const hash = createHash("sha1").update(targetFile.path).digest("hex");
		const snapshotFileName = `${hash}.md`;
		return path.join(this.snapshotDir, snapshotFileName);
	}
}
