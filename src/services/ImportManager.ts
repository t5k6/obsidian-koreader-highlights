import { type App, Notice, stringifyYaml, TFile, type TFolder } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { ProgressModal } from "src/ui/ProgressModal";
import { asyncPool } from "src/utils/concurrency";
import { getFileNameWithoutExt } from "src/utils/formatUtils";
import {
	convertCommentStyle,
	extractHighlightsWithStyle,
} from "src/utils/highlightExtractor";
import { logger } from "src/utils/logging";
import { getFrontmatterAndBody } from "src/utils/obsidianUtils";
import {
	addSummary,
	blankSummary,
	type CommentStyle,
	type LuaMetadata,
	type Summary,
} from "../types";
import type { DatabaseService } from "./DatabaseService";
import type { SDRFinder } from "./device/SDRFinder";
import type { FrontmatterGenerator } from "./parsing/FrontmatterGenerator";
import type { MetadataParser } from "./parsing/MetadataParser";
import type { ContentGenerator } from "./vault/ContentGenerator";
import type { DuplicateHandler } from "./vault/DuplicateHandler";
import type { SnapshotManager } from "./vault/SnapshotManager";

export class ImportManager {
	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly sdrFinder: SDRFinder,
		private readonly metadataParser: MetadataParser,
		private readonly databaseService: DatabaseService,
		private readonly frontmatterGenerator: FrontmatterGenerator,
		private readonly contentGenerator: ContentGenerator,
		private readonly duplicateHandler: DuplicateHandler,
		private readonly snapshotManager: SnapshotManager,
	) {}

	/**
	 * Main entry point for importing highlights from KOReader.
	 * Finds all SDR directories with metadata, processes them concurrently,
	 * and displays progress to the user.
	 * @returns Promise that resolves when import is complete
	 */
	async importHighlights(): Promise<void> {
		logger.info("ImportManager: Starting KOReader highlight import process…");

		const sdrPaths = await this.sdrFinder.findSdrDirectoriesWithMetadata();
		if (!sdrPaths?.length) {
			new Notice("No KOReader highlight files found (.sdr with metadata.lua).");
			logger.info("ImportManager: No SDR files found to import.");
			return;
		}

		const poolSize = Math.min(
			6,
			Math.max(2, navigator.hardwareConcurrency || 4),
		);
		logger.info(`ImportManager: Import concurrency = ${poolSize}`);

		const modal = new ProgressModal(this.app);
		modal.open();
		modal.setTotal(sdrPaths.length);

		this.duplicateHandler.resetApplyToAll();
		this.duplicateHandler.clearCache();

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
			logger.info("ImportManager: Import process finished", summary);
		} catch (err: any) {
			if (err?.name === "AbortError") {
				new Notice("Import cancelled by user.");
			} else {
				logger.error(
					"ImportManager: Critical error during highlight import process:",
					err,
				);
				new Notice("KOReader Importer: critical error. Check console.");
			}
		} finally {
			clearInterval(progressTicker);

			logger.info("ImportManager: Flushing database index …");
			await this.databaseService.flushIndex();

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
				logger.info(
					`ImportManager: Skipping – no annotations found in ${sdrPath}`,
				);
				summary.skipped++;
				return summary;
			}

			await this.enrichWithStatistics(luaMetadata);

			if (!luaMetadata.docProps.title) {
				luaMetadata.docProps.title = getFileNameWithoutExt(sdrPath);
				logger.warn(
					`ImportManager: Metadata missing title for ${sdrPath}, using filename as fallback.`,
				);
			}

			const fileSummary = await this.saveHighlightsToFile(luaMetadata);
			summary.created += fileSummary.created;
			summary.merged += fileSummary.merged;
			summary.automerged += fileSummary.automerged;
			summary.skipped += fileSummary.skipped;
		} catch (err) {
			logger.error(`ImportManager: Error processing ${sdrPath}`, err);
			summary.errors++;
		}

		return summary;
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

		const stats = await this.databaseService.findBookStatistics(
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
		logger.info(
			`ImportManager: Enriched metadata for "${title}" with stats DB info.`,
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

		// Delegate the entire decision tree to the DuplicateHandler
		const result = await this.duplicateHandler.resolveDuplicate(
			luaMetadata,
			contentProvider,
		);

		// Update summary based on the single, clear status returned
		summary[result.status]++;

		// If a file was created or modified, perform post-import actions
		if (result.file) {
			const bookKey = this.databaseService.bookKeyFromDocProps(
				luaMetadata.docProps,
			);
			await this.databaseService.upsertBook(
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
		logger.info(
			"ImportManager: Starting comment style conversion for all highlight files…",
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
			logger.info(
				`ImportManager: Comment style conversion finished - ${counts.converted} converted, ${counts.skipped} skipped`,
			);
		} catch (err: any) {
			if (err?.name === "AbortError") {
				new Notice("Comment style conversion cancelled by user.");
			} else {
				logger.error(
					"ImportManager: Error during comment style conversion:",
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

		const folder = <TFolder>(
			this.app.vault.getAbstractFileByPath(
				this.plugin.settings.highlightsFolder,
			)
		);
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
			logger.warn(
				"ImportManager: Detected files without KOHL comments during conversion to comment style",
			);
		}
	}

	/**
	 * Gets all markdown files in the highlights folder that need to be converted.
	 * @returns Promise resolving to array of files, or null if no files found
	 */
	private async getHighlightFilesToConvert(): Promise<TFile[] | null> {
		const folder = <TFolder>(
			this.app.vault.getAbstractFileByPath(
				this.plugin.settings.highlightsFolder,
			)
		);

		if (!folder || folder.children === undefined) {
			new Notice("Highlights folder not found. No files to convert.");
			logger.warn(
				"ImportManager: Highlights folder not found for comment style conversion.",
			);
			return null;
		}

		const files = folder.children.filter(
			(f): f is TFile => f instanceof TFile && f.extension === "md",
		);

		if (files.length === 0) {
			new Notice("No markdown files found in highlights folder.");
			logger.info("ImportManager: No files found to convert.");
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
			const { frontmatter, body } = await getFrontmatterAndBody(this.app, file);

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
			logger.error(`ImportManager: Error converting file ${file.path}:`, error);
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
		logger.info(`ImportManager: Removing KOHL comments from ${file.path}`);

		const newContent = this.reconstructFileContent(frontmatter, newBody);
		await this.app.vault.modify(file, newContent);
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

		// Check if this file has content but no KOHL comments (could be "none" style)
		if (annotations.length === 0 && body.trim().length > 100) {
			// This file likely has "none" style - no comments to convert from
			logger.info(
				`ImportManager: File ${file.path} appears to have no KOHL comments - likely "none" style`,
			);
			counts.skipped++; // Can't convert from none to comment style
			return;
		}

		if (annotations.length === 0) {
			// No highlights found at all, skip
			counts.skipped++;
			return;
		}

		let newBody = body;

		// Convert comment style if needed
		if (usedStyle && usedStyle !== targetStyle) {
			newBody = convertCommentStyle(body, usedStyle, targetStyle);
			counts.converted++;
			logger.info(
				`ImportManager: Converting ${file.path} from ${usedStyle} to ${targetStyle} style`,
			);
		} else if (usedStyle === targetStyle) {
			// Already correct style, but we still "rewrite" to ensure consistency
			counts.converted++;
		} else {
			// No KOHL comments found, skip
			counts.skipped++;
			return;
		}

		const newContent = this.reconstructFileContent(frontmatter, newBody);
		await this.app.vault.modify(file, newContent);
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
