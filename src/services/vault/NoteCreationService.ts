import type { TFile } from "obsidian";
import { isErr } from "src/lib/core/result";
import { getFileNameWithoutExt } from "src/lib/pathing/pathingUtils";
import type KoreaderImporterPlugin from "src/main";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import { createFrontmatterData } from "src/services/parsing/FrontmatterGenerator";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type { TemplateManager } from "src/services/parsing/TemplateManager";
import type { FileNameGenerator } from "src/services/vault/FileNameGenerator";
import type { NoteIdentityService } from "src/services/vault/NoteIdentityService";
import type { SnapshotManager } from "src/services/vault/SnapshotManager";
import type { LuaMetadata } from "src/types";

export class NoteCreationService {
	private readonly settings;
	private readonly log;

	constructor(
		private readonly fs: FileSystemService,
		private readonly fmService: FrontmatterService,
		private readonly fileNameGen: FileNameGenerator,
		private readonly snapshot: SnapshotManager,
		private readonly identity: NoteIdentityService,
		private readonly loggingService: LoggingService,
		private readonly templateManager: TemplateManager,
		readonly plugin: KoreaderImporterPlugin, // injected to access settings
	) {
		this.settings = plugin.settings;
		this.log = this.loggingService.scoped("NoteCreationService");
	}

	/**
	 * Renders the body content for a note from LuaMetadata.
	 * Pure: No side effects, just computes the body string.
	 * Handles template compilation, annotation composition, and styling.
	 * @param lua - LuaMetadata with annotations
	 * @returns Promise<string> - The rendered body content
	 * @throws Error if template compilation fails
	 */
	public async renderNoteBody(lua: LuaMetadata): Promise<string> {
		try {
			const compiled = await this.templateManager.getCompiledTemplate();
			return this.fmService.composeBody(
				lua.annotations ?? [],
				compiled,
				this.templateManager,
				this.settings.commentStyle,
				this.settings.maxHighlightGap,
			);
		} catch (err: any) {
			this.log.error("Failed to render note body", { lua, err });
			throw new Error(`Body rendering failed: ${err?.message ?? String(err)}`);
		}
	}

	// The optional provider returns BODY-ONLY. We compose FM here so every note is born with a UID.
	async createFromLua(
		lua: LuaMetadata,
		bodyProvider?: () => Promise<string>,
	): Promise<TFile> {
		// Pre-generate a UID so the note is born with a stable identity.
		const preUid = this.identity.generateUid();
		let content: string;
		const body = bodyProvider
			? await bodyProvider()
			: await this.renderNoteBody(lua);
		const fm = createFrontmatterData(lua, this.settings.frontmatter, preUid);
		content = this.fmService.reconstructFileContent(fm, body);

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

		// Mandatory snapshot on create; abort on failure to ensure consistent state
		try {
			// Create the initial snapshot from the known content using the pre-generated UID.
			const res = await this.snapshot.createSnapshotFromContent(
				file,
				content,
				preUid,
			);
			if (isErr(res)) {
				this.log.error("Snapshot creation failed for new file", {
					path: file.path,
					error: res.error,
				});
				throw new Error("Failed to create snapshot for new note");
			}
		} catch (err) {
			this.log.error("Snapshot creation failed for new file", {
				path: file.path,
				err,
			});
			throw err;
		}

		return file;
	}
}
