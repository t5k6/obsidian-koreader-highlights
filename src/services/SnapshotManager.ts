import { createHash } from "node:crypto";
import { type App, normalizePath, type TFile, type Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { logger } from "src/utils/logging";

export class SnapshotManager {
	private snapshotDir: string;
	private backupDir: string;

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private vault: Vault,
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
		await this.ensureDir(this.snapshotDir);
		const snapshotFileName = SnapshotManager.generateSnapshotFileName(
			targetFile.path,
		);
		const snapshotPath = normalizePath(
			`${this.snapshotDir}/${snapshotFileName}`,
		);

		try {
			const content = await this.vault.read(targetFile);
			await this.vault.adapter.write(snapshotPath, content);
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
		await this.ensureDir(this.backupDir);
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const backupFileName = `${targetFile.basename}-${timestamp}.md`;
		const backupPath = normalizePath(`${this.backupDir}/${backupFileName}`);

		try {
			const content = await this.vault.read(targetFile);
			await this.vault.adapter.write(backupPath, content);
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
		const snapshotFileName = SnapshotManager.generateSnapshotFileName(
			targetFile.path,
		);
		const snapshotPath = normalizePath(
			`${this.snapshotDir}/${snapshotFileName}`,
		);

		try {
			if (await this.vault.adapter.exists(snapshotPath)) {
				return await this.vault.adapter.read(snapshotPath);
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
}
