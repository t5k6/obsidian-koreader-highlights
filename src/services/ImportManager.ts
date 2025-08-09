import path from "node:path";
import { type App, Notice, type TFile, type TFolder } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import {
	bookKeyFromDocProps,
	getFileNameWithoutExt,
} from "src/utils/formatUtils";
import {
	convertCommentStyle,
	extractHighlightsWithStyle,
} from "src/utils/highlightExtractor";
import { runPoolWithProgress } from "src/utils/progressPool";
import {
	addSummary,
	blankSummary,
	type CommentStyle,
	type DuplicateHandlingSession,
	type LuaMetadata,
	type Summary,
} from "../types";
import type { DeviceStatisticsService } from "./device/DeviceStatisticsService";
import type { SDRFinder } from "./device/SDRFinder";
import type { FileSystemService } from "./FileSystemService";
import type { LoggingService } from "./LoggingService";
import type { FrontmatterGenerator } from "./parsing/FrontmatterGenerator";
import type { FrontmatterService } from "./parsing/FrontmatterService";
import type { MetadataParser } from "./parsing/MetadataParser";
import type { ContentGenerator } from "./vault/ContentGenerator";
import type { DuplicateFinder } from "./vault/DuplicateFinder";
import type { DuplicateHandler } from "./vault/DuplicateHandler";
import type { FileNameGenerator } from "./vault/FileNameGenerator";
import type { LocalIndexService } from "./vault/LocalIndexService";
import type { SnapshotManager } from "./vault/SnapshotManager";

// Pipeline helper types (kept local to this module for clarity)
type SkipReason = "UNCHANGED" | "NO_ANNOTATIONS" | "USER_DECISION";

type ImportAction =
	| { type: "SKIP"; reason: SkipReason }
	| { type: "CREATE"; withTimeoutWarning?: boolean }
	| {
			type: "MERGE";
			match: import("../types").DuplicateMatch;
			session: import("../types").DuplicateHandlingSession;
	  };

type ExecResult =
	| { status: "created"; file: TFile }
	| { status: "merged"; file: TFile }
	| { status: "automerged"; file: TFile }
	| { status: "skipped"; file: null };

interface PipelineContext {
	metadataPath: string;
	sdrPath: string;
	stats: { mtimeMs: number; size: number } | null;
	latestTs: string | null;
	luaMetadata: LuaMetadata | null;
}

export class ImportManager {
	private readonly log;

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly fileNameGenerator: FileNameGenerator,
		private readonly sdrFinder: SDRFinder,
		private readonly metadataParser: MetadataParser,
		private readonly deviceStatisticsService: DeviceStatisticsService,
		private readonly localIndexService: LocalIndexService,
		private readonly frontmatterGenerator: FrontmatterGenerator,
		private readonly contentGenerator: ContentGenerator,
		private readonly duplicateFinder: DuplicateFinder,
		private readonly duplicateHandler: DuplicateHandler,
		private readonly snapshotManager: SnapshotManager,
		private readonly loggingService: LoggingService,
		private readonly fs: FileSystemService,
		private readonly frontmatterService: FrontmatterService,
	) {
		this.log = this.loggingService.scoped("ImportManager");
	}

	/**
	 * Main entry point for importing highlights from KOReader.
	 * Finds all SDR directories with metadata, processes them concurrently,
	 * and displays progress to the user.
	 * @returns Promise that resolves when import is complete
	 */
	async importHighlights(): Promise<void> {
		this.log.info("Starting KOReader highlight import process…");

		const metadataFilePaths =
			await this.sdrFinder.findSdrDirectoriesWithMetadata();
		if (!metadataFilePaths?.length) {
			new Notice("No KOReader highlight files found (.sdr with metadata.lua).");
			this.log.info("No SDR files found to import.");
			return;
		}

		const session: DuplicateHandlingSession = {
			applyToAll: false,
			choice: null,
		};
		this.duplicateFinder.clearCache();

		let summary = blankSummary();

		try {
			const results = await runPoolWithProgress(this.app, metadataFilePaths, {
				maxConcurrent: 6,
				task: async (metadataPath) =>
					this.processMetadataFile(metadataPath, session),
			});

			for (const r of results) {
				summary = addSummary(summary, r.fileSummary);
			}

			new Notice(
				`KOReader Import finished\n${summary.created} new • ${summary.merged} merged • ${summary.automerged} auto-merged • ${summary.skipped} skipped • ${summary.errors} error(s)`,
				10_000,
			);
			this.log.info("Import process finished", summary);
		} catch (err: unknown) {
			if (
				typeof err === "object" &&
				err !== null &&
				(err as { name?: string }).name === "AbortError"
			) {
				new Notice("Import cancelled by user.");
			} else {
				this.log.error("Critical error during highlight import process:", err);
				new Notice("KOReader Importer: critical error. Check console.");
			}
		} finally {
			this.log.info("Flushing database index …");
			await this.localIndexService.flushIndex();
			try {
				await this.snapshotManager.cleanupOldBackups(
					this.plugin.settings.backupRetentionDays,
				);
			} catch (cleanupError) {
				this.log.error(
					"An error occurred during backup cleanup.",
					cleanupError,
				);
			}
		}
	}

	/**
	 * Runs the import pipeline for a single metadata.lua file; optionally forces a MERGE
	 * onto an existing note, bypassing duplicate discovery.
	 */
	public async runSingleFilePipeline(params: {
		metadataPath: string;
		existingNoteOverride?: TFile;
	}): Promise<{ changed: boolean; fileSummary: Summary }> {
		const session: DuplicateHandlingSession = {
			applyToAll: false,
			choice: null,
		};
		const { fileSummary } = await this.processMetadataFile(
			params.metadataPath,
			session,
			params.existingNoteOverride,
		);
		const changed =
			fileSummary.created + fileSummary.merged + fileSummary.automerged > 0;
		return { changed, fileSummary };
	}

	/**
	 * Processes a single SDR directory to extract and save highlights.
	 * @param sdrPath - Path to the SDR directory containing metadata.lua
	 * @param forceNote - Optional note to force a merge onto
	 * @returns Summary object with counts of created, merged, skipped, and error items
	 */
	private async processMetadataFile(
		metadataPath: string,
		session: DuplicateHandlingSession,
		forceNote?: TFile,
	): Promise<{ fileSummary: Summary; latestTimestampInFile: string | null }> {
		const summary = blankSummary();
		const ctx: PipelineContext = {
			metadataPath,
			sdrPath: path.dirname(metadataPath),
			stats: null,
			latestTs: null,
			luaMetadata: null,
		};

		try {
			// Stage 1: stats
			ctx.stats = await this.readSourceStats(metadataPath);

			// Stage 2: fast skip (by stats only)
			if (await this.shouldSkipSourceFast(metadataPath, ctx.stats)) {
				this.log.info(`Skipping unchanged file (fast): ${metadataPath}`);
				summary.skipped++;
				await this.recordOutcome(ctx, { luaMetadata: null, vaultPath: null });
				return { fileSummary: summary, latestTimestampInFile: null };
			}

			// Stage 3: parse + enrich
			const prepared = await this.prepareImportData(ctx.sdrPath);
			if (!prepared) {
				this.log.info(`Skipping – no annotations found in ${ctx.sdrPath}`);
				summary.skipped++;
				await this.recordOutcome(ctx, { luaMetadata: null, vaultPath: null });
				return { fileSummary: summary, latestTimestampInFile: null };
			}
			ctx.luaMetadata = prepared.luaMetadata;
			ctx.latestTs = prepared.latestTs;

			// Stage 4: final skip with timestamp (if unchanged)
			if (await this.shouldSkipSourceFinal(ctx)) {
				this.log.info(`Skipping unchanged file (final): ${metadataPath}`);
				summary.skipped++;
				await this.recordOutcome(ctx, {
					luaMetadata: ctx.luaMetadata,
					vaultPath: null,
				});
				return { fileSummary: summary, latestTimestampInFile: ctx.latestTs };
			}

			// Stage 5: resolve import action
			const action = await this.resolveImportAction(
				ctx.luaMetadata,
				session,
				forceNote,
			);
			if (action.type === "SKIP") {
				summary.skipped++;
				await this.recordOutcome(ctx, {
					luaMetadata: ctx.luaMetadata,
					vaultPath: null,
				});
				return { fileSummary: summary, latestTimestampInFile: ctx.latestTs };
			}

			// Stage 6: execute action
			const execResult = await this.executeImportAction(
				action,
				ctx.luaMetadata,
			);
			summary[execResult.status as keyof Summary]++;

			// Stage 7: record per-source success
			await this.recordOutcome(ctx, {
				luaMetadata: ctx.luaMetadata,
				vaultPath: execResult.file?.path ?? null,
			});

			return { fileSummary: summary, latestTimestampInFile: ctx.latestTs };
		} catch (err) {
			this.log.error(`Error processing ${metadataPath}`, err);
			summary.errors++;
			try {
				await this.localIndexService.recordImportFailure(metadataPath, err);
			} catch (e) {
				this.log.warn("Failed to record import failure state", e);
			}
			return { fileSummary: summary, latestTimestampInFile: ctx.latestTs };
		}
	}

	// --- Pipeline Stages & Helpers ---

	// 1) Stats
	private async readSourceStats(
		metadataPath: string,
	): Promise<{ mtimeMs: number; size: number } | null> {
		const stats = await this.fs.getNodeStats(metadataPath);
		return stats ? { mtimeMs: stats.mtime.getTime(), size: stats.size } : null;
	}

	// 2) Fast skip by unchanged stats (no parse)
	private async shouldSkipSourceFast(
		metadataPath: string,
		stats: { mtimeMs: number; size: number } | null,
	): Promise<boolean> {
		if (!stats) return false;
		const shouldProcess = await this.localIndexService.shouldProcessSource(
			metadataPath,
			{ mtime: stats.mtimeMs, size: stats.size },
			null,
		);
		return !shouldProcess;
	}

	// 3) Parse + enrich
	private async prepareImportData(
		sdrPath: string,
	): Promise<{ luaMetadata: LuaMetadata; latestTs: string | null } | null> {
		const luaMetadata = await this.metadataParser.parseFile(sdrPath);
		if (!luaMetadata?.annotations?.length) return null;

		// Latest annotation timestamp
		const latestTs = luaMetadata.annotations.reduce<string | null>(
			(acc, a) => (!acc || a.datetime > acc ? a.datetime : acc),
			null,
		);

		await this.enrichWithStatistics(luaMetadata);

		if (!luaMetadata.docProps.title) {
			luaMetadata.docProps.title = getFileNameWithoutExt(sdrPath);
			this.log.warn(
				`Metadata missing title for ${sdrPath}, using filename as fallback.`,
			);
		}
		return { luaMetadata, latestTs };
	}

	// 4) Final skip with timestamp
	private async shouldSkipSourceFinal(ctx: PipelineContext): Promise<boolean> {
		if (!ctx.stats) return false;
		return !(await this.localIndexService.shouldProcessSource(
			ctx.metadataPath,
			{ mtime: ctx.stats.mtimeMs, size: ctx.stats.size },
			ctx.latestTs,
		));
	}

	// 5) Resolve action (duplicate/timeout UX)
	private async resolveImportAction(
		luaMetadata: LuaMetadata,
		session: DuplicateHandlingSession,
		forceNote?: TFile,
	): Promise<ImportAction> {
		if (forceNote) {
			return {
				type: "MERGE",
				match: {
					file: forceNote,
					matchType: "updated",
					newHighlights: 0,
					modifiedHighlights: 0,
					luaMetadata,
					canMergeSafely: true,
				},
				session,
			};
		}
		const { match: bestMatch, timedOut } =
			await this.duplicateFinder.findBestMatch(luaMetadata);

		if (!bestMatch) {
			if (!timedOut) return { type: "CREATE" };
			const choice = await this.promptUserOnTimeout(
				luaMetadata.docProps.title || "Unknown title",
			);
			if (choice === "skip") {
				return { type: "SKIP", reason: "USER_DECISION" };
			}
			return { type: "CREATE", withTimeoutWarning: true };
		}

		// match present
		if (!timedOut) return { type: "MERGE", match: bestMatch, session };

		const choice = await this.promptUserOnTimeoutWithMatch(
			luaMetadata.docProps.title || "Unknown title",
			bestMatch.file.path,
		);
		if (choice === "skip") {
			return { type: "SKIP", reason: "USER_DECISION" };
		}
		if (choice === "create-new")
			return { type: "CREATE", withTimeoutWarning: true };
		return { type: "MERGE", match: bestMatch, session };
	}

	// 6) Execute action (FS + index writes)
	private async executeImportAction(
		action: ImportAction,
		luaMetadata: LuaMetadata,
	): Promise<ExecResult> {
		if (action.type === "SKIP") return { status: "skipped", file: null };

		const contentProvider = () => this.generateFileContent(luaMetadata);

		if (action.type === "CREATE") {
			const file = await this.createNewFile(luaMetadata, contentProvider, {
				withTimeoutWarning: action.withTimeoutWarning,
			});
			await this.afterFileWrite(luaMetadata, file);
			return { status: "created", file };
		}

		// MERGE path
		const result: { status: string; file: TFile | null } =
			await this.duplicateHandler.handleDuplicate(
				action.match,
				contentProvider,
				action.session,
			);

		if (result.status === "keep-both") {
			const file = await this.createNewFile(luaMetadata, contentProvider);
			await this.afterFileWrite(luaMetadata, file);
			return { status: "created", file };
		}

		if (result.file) {
			await this.afterFileWrite(luaMetadata, result.file);
		}

		switch (result.status) {
			case "automerged":
				return { status: "automerged", file: result.file! };
			case "merged":
			case "replaced":
			case "updated":
				return { status: "merged", file: result.file! };
			case "skipped":
			default:
				return { status: "skipped", file: null };
		}
	}

	// Shared post-write steps
	private async afterFileWrite(
		luaMetadata: LuaMetadata,
		file: TFile,
	): Promise<void> {
		const bookKey = bookKeyFromDocProps(luaMetadata.docProps);
		await this.localIndexService.upsertBook(
			luaMetadata.statistics?.book.id ?? null,
			bookKey,
			luaMetadata.docProps.title,
			luaMetadata.docProps.authors,
			file.path,
		);
		await this.snapshotManager.createSnapshot(file);
	}

	// 7) Record outcome
	private async recordOutcome(
		ctx: PipelineContext,
		options: { luaMetadata?: LuaMetadata | null; vaultPath?: string | null },
	): Promise<void> {
		const { luaMetadata, vaultPath } = options;
		const bookKey = luaMetadata
			? bookKeyFromDocProps(luaMetadata.docProps)
			: null;

		await this.localIndexService.recordImportSuccess({
			path: ctx.metadataPath,
			mtime: ctx.stats?.mtimeMs ?? 0,
			size: ctx.stats?.size ?? 0,
			newestAnnotationTs: ctx.latestTs,
			bookKey,
			md5: luaMetadata?.md5 ?? null,
			vaultPath: vaultPath ?? null,
		});
	}

	/**
	 * Enriches metadata with reading statistics from the database.
	 * Updates title and authors if better information is found in the database.
	 * @param luaMetadata - The metadata object to enrich
	 * @returns Promise that resolves when enrichment is complete
	 */
	private async enrichWithStatistics(luaMetadata: LuaMetadata): Promise<void> {
		const { md5, docProps } = luaMetadata;
		const { authors, title } = docProps;

		const stats = await this.deviceStatisticsService.findBookStatistics(
			title,
			authors,
			md5,
		);
		if (!stats) return;

		luaMetadata.statistics = stats;
		luaMetadata.docProps.title = stats.book.title;
		if (
			stats.book.authors &&
			stats.book.authors.trim().toLowerCase() !== "n/a"
		) {
			luaMetadata.docProps.authors = stats.book.authors;
		}
		this.log.info(`Enriched metadata for "${title}" with stats DB info.`);
	}

	/**
	 * Generic PromptModal helper to present choices and resolve the selected value.
	 */
	private async showPromptModal<T>(
		dialogTitle: string,
		message: string,
		options: { label: string; isCta?: boolean; value: T }[],
	): Promise<T> {
		const { PromptModal } = await import("../ui/PromptModal");
		return await new Promise<T>((resolve) => {
			// Using `unknown` to avoid any leakage of PromptModal's internal typing.
			const ModalCtor = PromptModal as unknown as {
				new (
					app: App,
					title: string,
					options: { label: string; isCta?: boolean; callback: () => void }[],
					message: string,
				): { open: () => void };
			};
			const modal = new ModalCtor(
				this.app,
				dialogTitle,
				options.map((o) => ({
					label: o.label,
					isCta: o.isCta,
					callback: () => resolve(o.value),
				})),
				message,
			);
			modal.open();
		});
	}

	/**
	 * Prompt user when duplicate scan timed out without finding a match.
	 * Returns 'skip' or 'import-anyway'.
	 */
	private async promptUserOnTimeout(
		title: string,
	): Promise<"skip" | "import-anyway"> {
		return this.showPromptModal<"skip" | "import-anyway">(
			"Duplicate scan timed out",
			`The duplicate scan for “${title}” did not complete within the configured timeout.\nTo avoid accidental duplicates:\n• Choose “Skip this book” to review and retry later.\n• Or “Import anyway” to create the note with a warning and needs-review flag.`,
			[
				{ label: "Skip this book", value: "skip" },
				{
					label: "Import anyway (add warning)",
					isCta: true,
					value: "import-anyway",
				},
			],
		);
	}

	/**
	 * Prompt user when duplicate scan timed out but a best match was found.
	 * Returns 'skip', 'create-new', or 'proceed'.
	 */
	private async promptUserOnTimeoutWithMatch(
		title: string,
		existingPath: string,
	): Promise<"skip" | "create-new" | "proceed"> {
		return this.showPromptModal<"skip" | "create-new" | "proceed">(
			"Duplicate scan timed out",
			`The duplicate scan for “${title}” did not complete within the configured timeout.\n` +
				`A potential existing note was found at:\n• ${existingPath}\n\n` +
				"To avoid accidental duplicates:\n" +
				"• Choose ‘Proceed to merge/replace’ to handle the match safely.\n" +
				"• Or ‘Create new file’ to add a warning and a needs-review flag.\n" +
				"• Or ‘Skip this book’ to review and retry later.",
			[
				{ label: "Skip this book", value: "skip" },
				{ label: "Create new file (add warning)", value: "create-new" },
				{ label: "Proceed to merge/replace", isCta: true, value: "proceed" },
			],
		);
	}

	/**
	 * Inject a duplicate-timeout warning and needs-review flag into content.
	 */
	private injectTimeoutWarning(content: string): string {
		try {
			const parsed = this.frontmatterService.parseContent(content);
			const fm = parsed.frontmatter || {};
			fm["needs-review"] = "duplicate-timeout";
			const warning =
				"> [!warning] Duplicate scan did not complete\n" +
				"> The scan timed out before searching the entire vault. Review this note to avoid duplicates.\n\n";
			return this.frontmatterService.reconstructFileContent(
				fm,
				warning + parsed.body,
			);
		} catch {
			return (
				"---\nneeds-review: duplicate-timeout\n---\n\n" +
				"> [!warning] Duplicate scan did not complete\n" +
				"> The scan timed out before searching the entire vault. Review this note to avoid duplicates.\n\n" +
				content
			);
		}
	}

	private async createNewFile(
		luaMetadata: LuaMetadata,
		contentProvider: () => Promise<string>,
		options?: { withTimeoutWarning?: boolean },
	): Promise<TFile> {
		let content = await contentProvider();

		// If requested, inject a prominent warning and a needs-review flag
		if (options?.withTimeoutWarning) {
			content = this.injectTimeoutWarning(content);
		}
		const fileNameWithExt = this.fileNameGenerator.generate(
			{
				useCustomTemplate: this.plugin.settings.useCustomFileNameTemplate,
				template: this.plugin.settings.fileNameTemplate,
				highlightsFolder: this.plugin.settings.highlightsFolder,
			},
			luaMetadata.docProps,
			luaMetadata.originalFilePath,
		);
		const fileNameStem = getFileNameWithoutExt(fileNameWithExt);

		return await this.fs.createVaultFileSafely(
			this.plugin.settings.highlightsFolder,
			fileNameStem, // Use the stem here
			content,
		);
	}

	/**
	 * Generates the complete markdown file content including frontmatter and highlights.
	 * @param luaMetadata - The metadata containing document props and annotations
	 * @returns The formatted markdown content as a string
	 */
	private async generateFileContent(luaMetadata: LuaMetadata): Promise<string> {
		const fmData = this.frontmatterGenerator.createFrontmatterData(
			luaMetadata,
			this.plugin.settings.frontmatter,
		);
		const highlights = await this.contentGenerator.generateHighlightsContent(
			luaMetadata.annotations,
		);

		return this.frontmatterService.reconstructFileContent(fmData, highlights);
	}

	/**
	 * Converts comment style in all existing highlight files to match current setting.
	 * This rewrites all files even if unchanged to ensure consistent comment style.
	 * @returns Promise that resolves when all files have been converted
	 */
	async convertAllFilesToCommentStyle(): Promise<void> {
		this.log.info("Starting comment style conversion for all highlight files…");

		const targetStyle = this.plugin.settings.commentStyle;
		await this.checkIfConvertingFromNone(targetStyle);

		const files = await this.getHighlightFilesToConvert();
		if (!files) return;

		const counts = { converted: 0, skipped: 0 };

		try {
			await runPoolWithProgress(this.app, files, {
				maxConcurrent: 4,
				task: async (file) => {
					await this.convertSingleFile(file, targetStyle, counts);
				},
			});

			new Notice(
				`Comment style conversion complete: ${counts.converted} files converted, ${counts.skipped} files skipped.`,
				8000,
			);
			this.log.info(
				`Comment style conversion finished - ${counts.converted} converted, ${counts.skipped} skipped`,
			);
		} catch (err: unknown) {
			if (
				typeof err === "object" &&
				err !== null &&
				(err as { name?: string }).name === "AbortError"
			) {
				new Notice("Comment style conversion cancelled by user.");
			} else {
				this.log.error("Error during comment style conversion:", err);
				new Notice(
					"Error during comment style conversion. Check console for details.",
				);
			}
		}
	}

	/**
	 * Checks if the conversion is from "none" style and warns the user about potential issues.
	 * @param targetStyle - The target comment style being converted to
	 */
	private async checkIfConvertingFromNone(targetStyle: string): Promise<void> {
		// Don't care if we want none anyway
		if (targetStyle === "none") return;

		const { files } = await this.fs.getFilesInFolder(
			this.plugin.settings.highlightsFolder,
			{ extensions: ["md"], recursive: false },
		);
		if (!files?.length) return;

		const sampleFiles = files.slice(0, 3); // Check first 3 files as sample

		let hasFilesWithoutComments = false;
		for (const file of sampleFiles) {
			try {
				const { body } = await this.frontmatterService.parseFile(file);
				const { annotations } = extractHighlightsWithStyle(body, "html");
				const { annotations: mdAnnotations } = extractHighlightsWithStyle(
					body,
					"md",
				);

				// If file has body content but no KOHL comments, it might be "none" style
				if (
					annotations.length === 0 &&
					mdAnnotations.length === 0 &&
					body.trim().length > 100
				) {
					hasFilesWithoutComments = true;
					break;
				}
			} catch (_error) {
				// Ignore read errors for this check
			}
		}

		if (hasFilesWithoutComments) {
			new Notice(
				`Warning: Some files appear to have no comment markers. Converting from "None" style to ${targetStyle} style cannot restore tracking information. New imports may create duplicates.`,
				8000,
			);
			this.log.warn(
				"Detected files without KOHL comments during conversion to comment style",
			);
		}
	}

	/**
	 * Gets all markdown files in the highlights folder that need to be converted.
	 * @returns Promise resolving to array of files, or null if no files found
	 */
	private async getHighlightFilesToConvert(): Promise<TFile[] | null> {
		const folderPath = this.plugin.settings.highlightsFolder;
		if (!folderPath) {
			new Notice("Highlights folder is not configured.");
			this.log.warn(
				"Highlights folder not configured for comment style conversion.",
			);
			return null;
		}

		const { files } = await this.fs.getFilesInFolder(folderPath, {
			extensions: ["md"],
			recursive: false, // original logic was non-recursive
		});

		if (files.length === 0) {
			new Notice("No markdown files found in highlights folder.");
			this.log.info("No files found to convert.");
			return null;
		}

		return files;
	}

	/**
	 * Converts a single file to the target comment style.
	 * @param file - File to convert
	 * @param targetStyle - Target comment style
	 * @param counts - Conversion counters to update
	 */
	private async convertSingleFile(
		file: TFile,
		targetStyle: CommentStyle,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		try {
			const { frontmatter, body } =
				await this.frontmatterService.parseFile(file);

			if (targetStyle === "none") {
				await this.convertToNoneStyle(file, body, frontmatter, counts);
			} else {
				await this.convertToCommentStyle(
					file,
					body,
					frontmatter,
					targetStyle,
					counts,
				);
			}
		} catch (error) {
			this.log.error(`Error converting file ${file.path}:`, error);
			counts.skipped++;
		}
	}

	/**
	 * Converts a file to "none" style by removing all KOHL comments.
	 * @param file - File to convert
	 * @param body - File body content
	 * @param frontmatter - File frontmatter
	 * @param counts - Conversion counters to update
	 */
	private async convertToNoneStyle(
		file: TFile,
		body: string,
		frontmatter: Record<string, unknown> | undefined,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		// Detect which KOHL comment style is used and route conversion accordingly
		const { usedStyle } = extractHighlightsWithStyle(body, "html");
		// If unsure, try both styles to ensure all markers are removed
		const newBody = usedStyle
			? convertCommentStyle(body, usedStyle, "none")
			: convertCommentStyle(
					convertCommentStyle(body, "html", "none"),
					"md",
					"none",
				);
		counts.converted++;
		this.log.info(`Removing KOHL comments from ${file.path}`);

		const newContent = this.frontmatterService.reconstructFileContent(
			frontmatter ?? {},
			newBody,
		);
		await this.fs.writeVaultFile(file.path, newContent);
	}

	/**
	 * Converts a file to a specific comment style (html or md).
	 * @param file - File to convert
	 * @param body - File body content
	 * @param frontmatter - File frontmatter
	 * @param targetStyle - Target comment style
	 * @param counts - Conversion counters to update
	 */
	private async convertToCommentStyle(
		file: TFile,
		body: string,
		frontmatter: Record<string, unknown> | undefined,
		targetStyle: CommentStyle,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		// Try to extract highlights and detect current style
		const { annotations, usedStyle } = extractHighlightsWithStyle(
			body,
			targetStyle,
		);

		if (annotations.length === 0 && body.trim().length > 100) {
			this.log.info(
				`File ${file.path} appears to have no KOHL comments - likely "none" style`,
			);
			counts.skipped++;
			return;
		}

		if (annotations.length === 0) {
			counts.skipped++;
			return;
		}

		let newBody = body;

		if (usedStyle && usedStyle !== targetStyle) {
			newBody = convertCommentStyle(body, usedStyle, targetStyle);
			counts.converted++;
			this.log.info(
				`Converting ${file.path} from ${usedStyle} to ${targetStyle} style`,
			);
		} else if (usedStyle === targetStyle) {
			// Already in the target style; don't rewrite, count as skipped for clarity
			counts.skipped++;
			this.log.info(`Skipping ${file.path} – already in ${targetStyle} style`);
			return;
		} else {
			counts.skipped++;
			return;
		}

		const newContent = this.frontmatterService.reconstructFileContent(
			frontmatter ?? {},
			newBody,
		);
		await this.fs.writeVaultFile(file.path, newContent);
	}
}
