import { type App, Notice, stringifyYaml, TFile, type TFolder } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { ProgressModal } from "src/ui/ProgressModal";
import { asyncPool } from "src/utils/concurrency";
import { getFileNameWithoutExt } from "src/utils/formatUtils";
import {
	convertCommentStyle,
	extractHighlightsWithStyle,
} from "src/utils/highlightExtractor";
import { getFrontmatterAndBody } from "src/utils/obsidianUtils";
import {
	addSummary,
	blankSummary,
	type CommentStyle,
	type LuaMetadata,
	type Summary,
} from "../types";
import type { DeviceStatisticsService } from "./device/DeviceStatisticsService";
import type { SDRFinder } from "./device/SDRFinder";
import type { FileSystemService } from "./FileSystemService";
import type { LoggingService } from "./LoggingService";
import type { FrontmatterGenerator } from "./parsing/FrontmatterGenerator";
import type { MetadataParser } from "./parsing/MetadataParser";
import type { ContentGenerator } from "./vault/ContentGenerator";
import type { DuplicateFinder } from "./vault/DuplicateFinder";
import type { DuplicateHandler } from "./vault/DuplicateHandler";
import type { FileNameGenerator } from "./vault/FileNameGenerator";
import type { LocalIndexService } from "./vault/LocalIndexService";
import type { SnapshotManager } from "./vault/SnapshotManager";

export class ImportManager {
	private readonly SCOPE = "ImportManager";

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
	) {}

	/**
	 * Main entry point for importing highlights from KOReader.
	 * Finds all SDR directories with metadata, processes them concurrently,
	 * and displays progress to the user.
	 * @returns Promise that resolves when import is complete
	 */
	async importHighlights(): Promise<void> {
		this.loggingService.info(
			this.SCOPE,
			"Starting KOReader highlight import process…",
		);

		const sdrPaths = await this.sdrFinder.findSdrDirectoriesWithMetadata();
		if (!sdrPaths?.length) {
			new Notice("No KOReader highlight files found (.sdr with metadata.lua).");
			this.loggingService.info(this.SCOPE, "No SDR files found to import.");
			return;
		}

		const poolSize = Math.min(
			6,
			Math.max(2, navigator.hardwareConcurrency || 4),
		);
		this.loggingService.info(this.SCOPE, `Import concurrency = ${poolSize}`);

		const modal = new ProgressModal(this.app);
		modal.open();
		modal.setTotal(sdrPaths.length);

		this.duplicateHandler.reset();
		this.duplicateFinder.clearCache();

		let summary = blankSummary();

		let doneCounter = 0;
		const progressTicker = setInterval(() => {
			modal.updateProgress(
				doneCounter,
				`${doneCounter}/${sdrPaths.length} processed`,
			);
		}, 200);

		try {
			const perFileSummaries = await asyncPool(
				poolSize,
				sdrPaths,
				async (sdrPath, idx) => {
					if (modal.abortSignal.aborted)
						throw new DOMException("Aborted by user", "AbortError");

					const res = await this.processSdr(sdrPath);
					doneCounter = idx + 1;
					return res;
				},
				modal.abortSignal,
			);

			for (const s of perFileSummaries) summary = addSummary(summary, s);

			new Notice(
				`KOReader Import finished\n${summary.created} new • ${
					summary.merged
				} merged • ${summary.automerged} auto-merged • ${
					summary.skipped
				} skipped • ${summary.errors} error(s)`,
				10_000,
			);
			this.loggingService.info(this.SCOPE, "Import process finished", summary);
		} catch (err: any) {
			if (err?.name === "AbortError") {
				new Notice("Import cancelled by user.");
			} else {
				this.loggingService.error(
					this.SCOPE,
					"Critical error during highlight import process:",
					err,
				);
				new Notice("KOReader Importer: critical error. Check console.");
			}
		} finally {
			clearInterval(progressTicker);

			this.loggingService.info(this.SCOPE, "Flushing database index …");
			await this.localIndexService.flushIndex();

			try {
				await this.snapshotManager.cleanupOldBackups(
					this.plugin.settings.backupRetentionDays,
				);
			} catch (cleanupError) {
				this.loggingService.error(
					this.SCOPE,
					"An error occurred during backup cleanup.",
					cleanupError,
				);
			}

			modal.close();
		}
	}

	/**
	 * Processes a single SDR directory to extract and save highlights.
	 * @param sdrPath - Path to the SDR directory containing metadata.lua
	 * @returns Summary object with counts of created, merged, skipped, and error items
	 */
	private async processSdr(sdrPath: string): Promise<Summary> {
		const summary = blankSummary();

		try {
			const luaMetadata = await this.metadataParser.parseFile(sdrPath);
			if (!luaMetadata?.annotations?.length) {
				this.loggingService.info(
					this.SCOPE,
					`Skipping – no annotations found in ${sdrPath}`,
				);
				summary.skipped++;
				return summary;
			}

			await this.enrichWithStatistics(luaMetadata);

			if (!luaMetadata.docProps.title) {
				luaMetadata.docProps.title = getFileNameWithoutExt(sdrPath);
				this.loggingService.warn(
					this.SCOPE,
					`Metadata missing title for ${sdrPath}, using filename as fallback.`,
				);
			}

			const fileSummary = await this.saveHighlightsToFile(luaMetadata);
			summary.created += fileSummary.created;
			summary.merged += fileSummary.merged;
			summary.automerged += fileSummary.automerged;
			summary.skipped += fileSummary.skipped;
			return addSummary(summary, fileSummary);
		} catch (err) {
			this.loggingService.error(this.SCOPE, `Error processing ${sdrPath}`, err);
			summary.errors++;
			return summary;
		}
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
		this.loggingService.info(
			this.SCOPE,
			`Enriched metadata for "${title}" with stats DB info.`,
		);
	}

	/**
	 * Saves highlights to a markdown file, handling duplicates appropriately.
	 * Creates snapshots for future 3-way merges and updates the database.
	 * @param luaMetadata - The metadata containing highlights to save
	 * @returns Summary object with counts of the operation results
	 */
	private async saveHighlightsToFile(
		luaMetadata: LuaMetadata,
	): Promise<Summary> {
		const summary = blankSummary();

		// Create a lazy provider for the file content
		const contentProvider = () => this.generateFileContent(luaMetadata);

		const bestMatch = await this.duplicateFinder.findBestMatch(luaMetadata);

		let result: { status: string; file: TFile | null };

		if (!bestMatch) {
			const newFile = await this.createNewFile(luaMetadata, contentProvider);
			result = { status: "created", file: newFile };
		} else {
			result = await this.duplicateHandler.handleDuplicate(
				bestMatch,
				contentProvider,
			);
			if (result.status === "keep-both") {
				const newFile = await this.createNewFile(luaMetadata, contentProvider);
				// The summary will still count this as 'created'
				result = { status: "created", file: newFile };
			}
		}

		// Update summary based on the single, clear status returned
		summary[result.status as keyof Summary]++;

		// If a file was created or modified, perform post-import actions
		if (result.file) {
			const bookKey = this.localIndexService.bookKeyFromDocProps(
				luaMetadata.docProps,
			);
			await this.localIndexService.upsertBook(
				luaMetadata.statistics?.book.id ?? null,
				bookKey,

				luaMetadata.docProps.title,
				luaMetadata.docProps.authors,
				result.file.path,
			);
			// Create a snapshot for future 3-way merges
			await this.snapshotManager.createSnapshot(result.file);
		}

		return summary;
	}

	private async createNewFile(
		luaMetadata: LuaMetadata,
		contentProvider: () => Promise<string>,
	): Promise<TFile> {
		const content = await contentProvider();
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
		const fm = this.frontmatterGenerator.generateYamlFromLuaMetadata(
			luaMetadata,
			this.plugin.settings.frontmatter,
		);
		const highlights = await this.contentGenerator.generateHighlightsContent(
			luaMetadata.annotations,
		);

		return `${fm}\n\n${highlights.trim()}`;
	}

	/**
	 * Converts comment style in all existing highlight files to match current setting.
	 * This rewrites all files even if unchanged to ensure consistent comment style.
	 * @returns Promise that resolves when all files have been converted
	 */
	async convertAllFilesToCommentStyle(): Promise<void> {
		this.loggingService.info(
			this.SCOPE,
			"Starting comment style conversion for all highlight files…",
		);

		const targetStyle = this.plugin.settings.commentStyle;

		// Check if converting from "none" style and warn user
		await this.checkIfConvertingFromNone(targetStyle);

		// Get files to convert
		const files = await this.getHighlightFilesToConvert();
		if (!files) return;

		// Setup progress tracking
		const modal = new ProgressModal(this.app);
		modal.open();
		modal.setTotal(files.length);

		const counts = { converted: 0, skipped: 0 };
		let doneCounter = 0;

		const progressTicker = setInterval(() => {
			modal.updateProgress(
				doneCounter,
				`${doneCounter}/${files.length} files processed`,
			);
		}, 200);

		try {
			const poolSize = Math.min(
				4,
				Math.max(2, navigator.hardwareConcurrency || 4),
			);

			await asyncPool(
				poolSize,
				files,
				async (file, idx) => {
					if (modal.abortSignal.aborted) {
						throw new DOMException("Aborted by user", "AbortError");
					}

					await this.convertSingleFile(file, targetStyle, counts);
					doneCounter = idx + 1;
				},
				modal.abortSignal,
			);

			new Notice(
				`Comment style conversion complete: ${counts.converted} files converted, ${counts.skipped} files skipped.`,
				8000,
			);
			this.loggingService.info(
				this.SCOPE,
				`Comment style conversion finished - ${counts.converted} converted, ${counts.skipped} skipped`,
			);
		} catch (err: any) {
			if (err?.name === "AbortError") {
				new Notice("Comment style conversion cancelled by user.");
			} else {
				this.loggingService.error(
					this.SCOPE,
					"Error during comment style conversion:",
					err,
				);
				new Notice(
					"Error during comment style conversion. Check console for details.",
				);
			}
		} finally {
			clearInterval(progressTicker);
			modal.close();
		}
	}

	/**
	 * Checks if the conversion is from "none" style and warns the user about potential issues.
	 * @param targetStyle - The target comment style being converted to
	 */
	private async checkIfConvertingFromNone(targetStyle: string): Promise<void> {
		// Don't care if we want none anyway
		if (targetStyle === "none") return;

		const folder = this.app.vault.getAbstractFileByPath(
			this.plugin.settings.highlightsFolder,
		) as TFolder;
		if (!folder || !folder.children) return;

		const sampleFiles = folder.children
			.filter((f): f is TFile => f instanceof TFile && f.extension === "md")
			.slice(0, 3); // Check first 3 files as sample

		let hasFilesWithoutComments = false;
		for (const file of sampleFiles) {
			try {
				const content = await this.app.vault.read(file);
				const { annotations } = extractHighlightsWithStyle(content, "html");
				const { annotations: mdAnnotations } = extractHighlightsWithStyle(
					content,
					"md",
				);

				// If file has highlights content but no KOHL comments, it might be "none" style
				if (
					annotations.length === 0 &&
					mdAnnotations.length === 0 &&
					content.trim().length > 100
				) {
					hasFilesWithoutComments = true;
					break;
				}
			} catch (error) {
				// Ignore read errors for this check
			}
		}

		if (hasFilesWithoutComments) {
			new Notice(
				`Warning: Some files appear to have no comment markers. Converting from "None" style to ${targetStyle} style cannot restore tracking information. New imports may create duplicates.`,
				8000,
			);
			this.loggingService.warn(
				this.SCOPE,
				"Detected files without KOHL comments during conversion to comment style",
			);
		}
	}

	/**
	 * Gets all markdown files in the highlights folder that need to be converted.
	 * @returns Promise resolving to array of files, or null if no files found
	 */
	private async getHighlightFilesToConvert(): Promise<TFile[] | null> {
		const folder = this.app.vault.getAbstractFileByPath(
			this.plugin.settings.highlightsFolder,
		) as TFolder;

		if (!folder || folder.children === undefined) {
			new Notice("Highlights folder not found. No files to convert.");
			this.loggingService.warn(
				this.SCOPE,
				"Highlights folder not found for comment style conversion.",
			);
			return null;
		}

		const files = folder.children.filter(
			(f): f is TFile => f instanceof TFile && f.extension === "md",
		);

		if (files.length === 0) {
			new Notice("No markdown files found in highlights folder.");
			this.loggingService.info(this.SCOPE, "No files found to convert.");
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
			const { frontmatter, body } = await getFrontmatterAndBody(
				this.app,
				file,
				this.loggingService,
			);

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
			this.loggingService.error(
				this.SCOPE,
				`Error converting file ${file.path}:`,
				error,
			);
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
		frontmatter: any,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		// Remove any existing KOHL comments
		const newBody = convertCommentStyle(body, "html", "none"); // This removes all comments
		counts.converted++;
		this.loggingService.info(
			this.SCOPE,
			`Removing KOHL comments from ${file.path}`,
		);

		const newContent = this.reconstructFileContent(frontmatter, newBody);
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
		frontmatter: any,
		targetStyle: CommentStyle,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		// Try to extract highlights and detect current style
		const { annotations, usedStyle } = extractHighlightsWithStyle(
			body,
			targetStyle,
		);

		if (annotations.length === 0 && body.trim().length > 100) {
			this.loggingService.info(
				this.SCOPE,
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
			this.loggingService.info(
				this.SCOPE,
				`Converting ${file.path} from ${usedStyle} to ${targetStyle} style`,
			);
		} else if (usedStyle === targetStyle) {
			counts.converted++;
		} else {
			counts.skipped++;
			return;
		}

		const newContent = this.reconstructFileContent(frontmatter, newBody);
		await this.fs.writeVaultFile(file.path, newContent);
	}

	/**
	 * Reconstructs file content with frontmatter and body.
	 * @param frontmatter - File frontmatter object
	 * @param body - File body content
	 * @returns Complete file content string
	 */
	private reconstructFileContent(frontmatter: any, body: string): string {
		if (frontmatter && Object.keys(frontmatter).length > 0) {
			const yamlString = stringifyYaml(frontmatter);
			return `---\n${yamlString}---\n\n${body.trim()}`;
		} else {
			return body.trim();
		}
	}
}
