import type { App } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { ImportIndex, ImportIndexEntry } from "src/types";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";

const INDEX_FILE_NAME = "import-index.json";

export class ImportIndexService {
	private index: ImportIndex = {};
	private indexFilePath: string;
	private isDirty = false;
	private readonly SCOPE = "ImportIndexService";

	constructor(
		private readonly plugin: KoreaderImporterPlugin,
		private readonly app: App,
		private readonly fs: FileSystemService,
		private readonly logging: LoggingService,
	) {
		this.indexFilePath = this.fs.joinPluginDataPath(INDEX_FILE_NAME);
	}

	public async load(): Promise<void> {
		if (await this.fs.vaultExists(this.indexFilePath)) {
			try {
				const content = await this.app.vault.adapter.read(this.indexFilePath);
				if (content) {
					this.index = JSON.parse(content);
					this.logging.info(
						this.SCOPE,
						`Loaded import index with ${Object.keys(this.index).length} entries.`,
					);
				}
			} catch (e) {
				this.logging.error(
					this.SCOPE,
					"Failed to load or parse import index. Starting fresh.",
					e as Error,
				);
				this.index = {};
			}
		} else {
			this.logging.info(
				this.SCOPE,
				"No import index found. A new one will be created.",
			);
		}
		this.isDirty = false;
	}

	public async save(): Promise<void> {
		if (!this.isDirty) return;
		try {
			await this.fs.ensurePluginDataDirExists();
			await this.app.vault.adapter.write(
				this.indexFilePath,
				JSON.stringify(this.index, null, 2),
			);
			this.isDirty = false;
			this.logging.info(
				this.SCOPE,
				`Successfully saved import index to ${this.indexFilePath}.`,
			);
		} catch (e) {
			this.logging.error(
				this.SCOPE,
				"Failed to save KOReader import index.",
				e as Error,
			);
		}
	}

	public getEntry(metadataFilePath: string): ImportIndexEntry | undefined {
		return this.index[metadataFilePath];
	}

	public updateEntry(metadataFilePath: string, entry: ImportIndexEntry): void {
		this.index[metadataFilePath] = entry;
		this.isDirty = true;
	}

	public clear(): void {
		this.index = {};
		this.isDirty = true;
	}

	/**
	 * Physically deletes the import index file from disk.
	 * This is intended for a full reset to avoid stale or corrupted state.
	 * After deletion, the in-memory index is cleared.
	 */
	public async deleteIndexFile(): Promise<void> {
		this.logging.warn(this.SCOPE, "Deleting import index file for full reset.");

		// Reset in-memory state regardless of file deletion outcome
		this.index = {};
		this.isDirty = false;

		try {
			if (await this.fs.vaultExists(this.indexFilePath)) {
				await this.app.vault.adapter.remove(this.indexFilePath);
				this.logging.info(
					this.SCOPE,
					`Successfully deleted import index file at ${this.indexFilePath}.`,
				);
			}
		} catch (e) {
			this.logging.error(
				this.SCOPE,
				`Failed to delete import index file at ${this.indexFilePath}.`,
				e as Error,
			);
			// Proceed even if deletion fails; memory state is cleared.
		}
	}
}

export default ImportIndexService;
