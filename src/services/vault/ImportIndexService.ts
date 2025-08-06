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
}

export default ImportIndexService;
