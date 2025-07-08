import { createHash } from "node:crypto";
import { type App, normalizePath, type TFile, type Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { logger } from "src/utils/logging";

export class SnapshotManager {
	private snapshotDir: string;

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private vault: Vault,
	) {
		this.snapshotDir = normalizePath(
			`${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/snapshots`,
		);
	}

	private async ensureSnapshotDir(): Promise<void> {
		try {
			const adapter = this.vault.adapter;
			const dirExists = await adapter.exists(this.snapshotDir);
			if (!dirExists) {
				await adapter.mkdir(this.snapshotDir);
				logger.info(
					`SnapshotManager: Snapshot directory created at ${this.snapshotDir}`,
				);
			}
		} catch (error) {
			logger.error(
				"SnapshotManager: Failed to create snapshot directory",
				error,
			);
			throw new Error("Failed to ensure snapshot directory exists.");
		}
	}

	public async createSnapshot(targetFile: TFile): Promise<void> {
		await this.ensureSnapshotDir();
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
		// Use a hash of the file path to create a stable, filesystem-safe name
		// IMPORTANT: Do not change the hash algorithm from sha1 to avoid breaking existing snapshots.
		const hash = createHash("sha1").update(filePath).digest("hex");
		return `${hash}.md`;
	}
}
