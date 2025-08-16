import type { TFile } from "obsidian";
import { getFileNameWithoutExt } from "src/lib/pathing/pathingUtils";
import type KoreaderImporterPlugin from "src/main";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { FrontmatterGenerator } from "src/services/parsing/FrontmatterGenerator";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type { ContentGenerator } from "src/services/vault/ContentGenerator";
import type { FileNameGenerator } from "src/services/vault/FileNameGenerator";
import type { SnapshotManager } from "src/services/vault/SnapshotManager";
import type { LuaMetadata } from "src/types";

export class NoteCreationService {
	private readonly settings;

	constructor(
		private readonly fs: FileSystemService,
		private readonly fmService: FrontmatterService,
		private readonly fmGen: FrontmatterGenerator,
		private readonly contentGen: ContentGenerator,
		private readonly fileNameGen: FileNameGenerator,
		private readonly snapshot: SnapshotManager,
		private readonly log: LoggingService,
		readonly plugin: KoreaderImporterPlugin, // injected to access settings
	) {
		this.settings = plugin.settings;
	}

	// Optional content provider allows callers to precompose body/frontmatter if needed.
	async createFromLua(
		lua: LuaMetadata,
		contentProvider?: () => Promise<string>,
	): Promise<TFile> {
		const fm = this.fmGen.createFrontmatterData(lua, this.settings.frontmatter);
		const body = contentProvider
			? await contentProvider()
			: await this.contentGen.generateHighlightsContent(lua.annotations);
		const content = this.fmService.reconstructFileContent(fm, body);

		// Derive a base stem using the same generator users expect
		const fileNameWithExt = this.fileNameGen.generate(
			{
				useCustomTemplate: this.settings.useCustomFileNameTemplate,
				template: this.settings.fileNameTemplate,
				highlightsFolder: this.settings.highlightsFolder,
			},
			lua.docProps,
			lua.originalFilePath ?? undefined,
		);
		const baseStem = getFileNameWithoutExt(fileNameWithExt);

		// Create unique file (ensures folder exists and picks unique stem if needed)
		const file = await this.fs.createVaultFileUnique(
			this.settings.highlightsFolder,
			baseStem,
			content,
		);

		// Optional snapshot on create; log on failure but don't fail the op
		try {
			// Create the initial snapshot from the known content for future 3-way merges.
			await this.snapshot.createSnapshotFromContent(file, content);
		} catch (err) {
			this.log.warn("Snapshot creation skipped/failed for new file", {
				path: file.path,
				err,
			});
		}

		return file;
	}
}
