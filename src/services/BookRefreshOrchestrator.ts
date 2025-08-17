import path from "node:path";
import type { TFile } from "obsidian";
import type { KoreaderEnvironmentService } from "./device/KoreaderEnvironmentService";
import type { SDRFinder } from "./device/SDRFinder";
import type { FileSystemService } from "./FileSystemService";
import type { ImportPipelineService } from "./ImportPipelineService";
import type { LoggingService } from "./LoggingService";
import type { LocalIndexService } from "./vault/LocalIndexService";

export class BookRefreshOrchestrator {
	private readonly log: ReturnType<LoggingService["scoped"]>;

	constructor(
		private readonly localIndex: LocalIndexService,
		private readonly importPipelineService: ImportPipelineService,
		private readonly sdrFinder: SDRFinder,
		private readonly envService: KoreaderEnvironmentService,
		private readonly fs: FileSystemService,
		private readonly loggingService: LoggingService,
	) {
		this.log = this.loggingService.scoped("BookRefreshOrchestrator");
	}

	/** Refresh one note. Returns true if anything changed. */
	async refreshNote(note: TFile): Promise<boolean> {
		const bookKey = await this.localIndex.findKeyByVaultPath(note.path);
		if (!bookKey)
			throw new Error("This note is not tracked in the KOReader index");

		const src = await this.localIndex.latestSourceForBook(bookKey);
		if (!src) throw new Error("No source metadata.lua recorded for this book");

		const mount = await this.envService.getActiveScanPath();
		if (!mount) throw new Error("KOReader device not connected");

		const fullSrcPath = path.join(mount, src);
		if (!(await this.fs.nodeFileExists(fullSrcPath))) {
			throw new Error("metadata.lua not found on device");
		}

		const result = await this.importPipelineService.runSingleFilePipeline({
			metadataPath: fullSrcPath,
			existingNoteOverride: note,
		});

		this.log.info(
			`Refresh finished for ${note.path}: created=${result.fileSummary.created}, merged=${result.fileSummary.merged}, automerged=${result.fileSummary.automerged}, skipped=${result.fileSummary.skipped}`,
		);

		return result.changed;
	}
}
