import { normalizePath, type App, TFile, Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { devError, devLog } from "src/utils/logging";
import { getFrontmatterAndBody } from "src/utils/obsidianUtils";
import { createHash } from "crypto";

function generateSnapshotFileName(filePath: string): string {
    // Use a hash of the file path to create a stable, filesystem-safe name
    const hash = createHash('sha1').update(filePath).digest('hex');
    return `${hash}.md`;
}

export class SnapshotManager {
    private snapshotDir: string;

    constructor(
        private app: App,
        private plugin: KoreaderImporterPlugin,
        private vault: Vault
    ) {
        this.snapshotDir = normalizePath(
            `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}/snapshots`
        );
    }

    private async ensureSnapshotDir(): Promise<void> {
        try {
            const adapter = this.vault.adapter;
            const dirExists = await adapter.exists(this.snapshotDir);
            if (!dirExists) {
                await adapter.mkdir(this.snapshotDir);
                devLog("Snapshot directory created at", this.snapshotDir);
            }
        } catch (error) {
            devError("Failed to create snapshot directory", error);
        }
    }
    
    public async createSnapshot(targetFile: TFile): Promise<void> {
        await this.ensureSnapshotDir();
        const snapshotFileName = generateSnapshotFileName(targetFile.path);
        const snapshotPath = normalizePath(`${this.snapshotDir}/${snapshotFileName}`);

        try {
            const content = await this.vault.read(targetFile);
            await this.vault.adapter.write(snapshotPath, content);
            devLog(`Created snapshot for ${targetFile.path} at ${snapshotPath}`);
        } catch (error) {
            devError(`Failed to write snapshot for ${targetFile.path}`, error);
        }
    }

    public async getSnapshotContent(targetFile: TFile): Promise<string | null> {
        const snapshotFileName = generateSnapshotFileName(targetFile.path);
        const snapshotPath = normalizePath(`${this.snapshotDir}/${snapshotFileName}`);

        try {
            if (await this.vault.adapter.exists(snapshotPath)) {
                return await this.vault.adapter.read(snapshotPath);
            }
            return null;
        } catch (error) {
            devError(`Failed to read snapshot for ${targetFile.path}`, error);
            return null;
        }
    }
}