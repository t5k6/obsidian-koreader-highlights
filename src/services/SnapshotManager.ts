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

	static generateSnapshotFileName(filePath: string): string {
		const hash = createHash("sha1").update(filePath).digest("hex");
		return `${hash}.md`;
	}
}
