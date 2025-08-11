import path from "node:path";
import { type App, Notice, type TFile, type TFolder } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { PromptService } from "src/services/ui/PromptService";
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
	type FileOperationResult,
	type LuaMetadata,
	type Summary,
} from "../types";
import type { DeviceStatisticsService } from "./device/DeviceStatisticsService";
import type { SDRFinder } from "./device/SDRFinder";
import type { FileSystemService } from "./FileSystemService";
import { ImportPipeline } from "./import/pipeline/runner";
import {
	FastSkipStep,
	FinalSkipStep,
	ParseEnrichStep,
	ResolveActionStep,
	StatsStep,
} from "./import/pipeline/steps";
import type {
	ImportContext,
	ImportIO,
	WarningCode,
} from "./import/pipeline/types";
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
		private readonly promptService: PromptService,
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

		// Helper to execute one full pass over all metadata files
		const runOnce = async (forceReimport: boolean): Promise<Summary> => {
			const session: DuplicateHandlingSession = {
				applyToAll: false,
				choice: null,
			};
			this.duplicateFinder.clearCache();
			let passSummary = blankSummary();
			const results = await runPoolWithProgress(this.app, metadataFilePaths, {
				maxConcurrent: 6,
				task: async (metadataPath) =>
					this.processMetadataFile(metadataPath, session, undefined, {
						forceReimport,
					}),
			});
			for (const r of results) {
				passSummary = addSummary(passSummary, r.fileSummary);
			}
			return passSummary;
		};

		let summary = blankSummary();

		try {
			// First pass (normal behavior)
			summary = await runOnce(false);

			const workDone =
				summary.created + summary.merged + summary.automerged > 0;
			const allSkipped = !workDone && summary.skipped > 0;

			if (allSkipped) {
				const choice = await this.promptService.confirm({
					title: "No New Highlights Found",
					message:
						"No changes were detected. Re-import all books anyway? This is useful if you have changed your highlight templates.",
					ctaLabel: "Yes, Re-import",
					cancelLabel: "Finish",
				});

				if (choice === "confirm") {
					new Notice("Forcing re-import of all books...", 3000);
					// Second pass with forced re-import
					summary = await runOnce(true);
				}
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
		opts?: { forceReimport?: boolean },
	): Promise<{ fileSummary: Summary; latestTimestampInFile: string | null }> {
		const summary = blankSummary();
		const pipeline = this.createPipeline();
		const initialCtx: ImportContext = {
			metadataPath,
			sdrPath: path.dirname(metadataPath),
			forceNote: forceNote ?? null,
			session,
			stats: null,
			latestTs: null,
			luaMetadata: null,
			warnings: [] as WarningCode[],
			forceReimport: opts?.forceReimport ?? false,
		};

		try {
			const { result, ctx } = await pipeline.run(initialCtx);
			switch (result.status) {
				case "created":
					summary.created++;
					break;
				case "merged":
					summary.merged++;
					break;
				case "automerged":
					summary.automerged++;
					break;
				case "skipped":
				default:
					summary.skipped++;
			}
			return { fileSummary: summary, latestTimestampInFile: ctx.latestTs };
		} catch (err) {
			this.log.error(`Error processing ${metadataPath}`, err);
			summary.errors++;
			try {
				await this.localIndexService.recordImportFailure(metadataPath, err);
			} catch (e) {
				this.log.warn("Failed to record import failure state", e);
			}
			return { fileSummary: summary, latestTimestampInFile: null };
		}
	}

	private buildIO(): ImportIO {
		return {
			fs: this.fs,
			index: this.localIndexService,
			parser: this.metadataParser,
			statsSvc: this.deviceStatisticsService,
			fmService: this.frontmatterService,
			fmGen: this.frontmatterGenerator,
			contentGen: this.contentGenerator,
			dupFinder: this.duplicateFinder,
			dupHandler: this.duplicateHandler,
			fileNameGen: this.fileNameGenerator,
			snapshot: this.snapshotManager,
			settings: this.plugin.settings,
			app: this.app,
			log: this.loggingService,
			ui: this.promptService,
		};
	}

	private createPipeline(): ImportPipeline {
		return new ImportPipeline(
			[
				StatsStep,
				FastSkipStep,
				ParseEnrichStep,
				FinalSkipStep,
				ResolveActionStep,
			],
			this.buildIO(),
		);
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
			recursive: false,
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
