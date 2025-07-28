import { type App, Notice, TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { ProgressModal } from "src/ui/ProgressModal";
import { asyncPool } from "src/utils/concurrency";
import { getFileNameWithoutExt } from "src/utils/formatUtils";
import { logger } from "src/utils/logging";
import {
	addSummary,
	blankSummary,
	type LuaMetadata,
	type Summary,
} from "../types";
import type { ContentGenerator } from "./ContentGenerator";
import type { DatabaseService } from "./DatabaseService";
import type { DuplicateHandler } from "./DuplicateHandler";
import type { FrontmatterGenerator } from "./FrontmatterGenerator";
import type { MetadataParser } from "./MetadataParser";
import type { SDRFinder } from "./SDRFinder";
import type { SnapshotManager } from "./SnapshotManager";

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
}
