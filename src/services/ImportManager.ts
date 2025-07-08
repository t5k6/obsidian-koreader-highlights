import { type App, Notice, TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { ProgressModal } from "src/ui/ProgressModal";
import { asyncPool } from "src/utils/concurrency";
import { createFileSafely, ensureParentDirectory } from "src/utils/fileUtils";
import {
	generateObsidianFileName,
	getFileNameWithoutExt,
} from "src/utils/formatUtils";
import { logger } from "src/utils/logging";
import {
	addSummary,
	blankSummary,
	type DuplicateMatch,
	type LuaMetadata,
} from "../types";
import type { ContentGenerator } from "./ContentGenerator";
import type { DatabaseService } from "./DatabaseService";
import type { DuplicateHandler } from "./DuplicateHandler";
import type { FrontmatterGenerator } from "./FrontmatterGenerator";
import type { MetadataParser } from "./MetadataParser";
import type { SDRFinder } from "./SDRFinder";
import type { SnapshotManager } from "./SnapshotManager";

type Summary = {
	created: number;
	merged: number;
	automerged: number;
	skipped: number;
	errors: number;
};

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

		/* ---  tiny helpers  --- */
		let doneCounter = 0;
		const progressTicker = setInterval(() => {
			modal.updateProgress(
				doneCounter,
				`${doneCounter}/${sdrPaths.length} processed`,
			);
		}, 200); // update UI at most 5×/s

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

			// aggregate
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

			// One single flush, avoids sql.js race conditions
			logger.info("ImportManager: Flushing database index …");
			await this.databaseService.flushIndex();

			modal.close();
		}
	}

	async clearCaches(): Promise<void> {
		this.sdrFinder.clearCache();
		this.metadataParser.clearCache();
		this.duplicateHandler.clearCache();
		logger.info("ImportManager: Import-related caches cleared.");
	}

	/* ------------------------------------------------------------------ */
	/*                             PRIVATE                                */
	/* ------------------------------------------------------------------ */

	private async processSdr(sdrPath: string): Promise<Summary> {
		const summary = blankSummary();

		try {
			/* 1 ──────────────────  Parse metadata  ───────────────────────── */
			const luaMetadata = await this.metadataParser.parseFile(sdrPath);
			if (!luaMetadata?.annotations?.length) {
				logger.info(
					`ImportManager: Skipping – no annotations found in ${sdrPath}`,
				);
				summary.skipped++;
				return summary;
			}

			/* 2 ───────────────────── Stats lookup  ───────────────────────── */
			await this.enrichWithStatistics(luaMetadata, sdrPath);

			/* 3 ───────────────────  Missing title  ───────────────────────── */
			if (!luaMetadata.docProps.title) {
				luaMetadata.docProps.title = getFileNameWithoutExt(sdrPath);
				logger.warn(
					`ImportManager: Metadata missing title for ${sdrPath}, using filename as fallback.`,
				);
			}

			/* 4 ─────────────────  Save highlights  ───────────────────────── */
			const bookKey = this.databaseService.bookKeyFromDocProps(
				luaMetadata.docProps,
			);

			const fileSummary = await this.saveHighlightsToFile(luaMetadata, bookKey);

			summary.created += fileSummary.created;
			summary.merged += fileSummary.merged;
			summary.automerged += fileSummary.automerged;
			summary.skipped += fileSummary.skipped;
			summary.errors += fileSummary.errors;
		} catch (err) {
			logger.error(`ImportManager: Error processing ${sdrPath}`, err);
			summary.errors++;
		}

		return summary;
	}

	/* ---------------------- helper: statistics ------------------------ */
	private async enrichWithStatistics(
		luaMetadata: LuaMetadata,
		sdrPath: string,
	): Promise<void> {
		const { md5, docProps } = luaMetadata;
		const { authors, title } = docProps;

		// Use the new, more robust statistics finder
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
			`ImportManager: Enriched metadata for "${sdrPath}" with stats DB info.`,
		);
	}

	/* ---------------------- helper: save/merge ------------------------ */
	private async saveHighlightsToFile(
		luaMetadata: LuaMetadata,
		bookKey: string,
	): Promise<Summary> {
		const result: Summary = {
			created: 0,
			merged: 0,
			automerged: 0,
			skipped: 0,
			errors: 0,
		};

		const potentialDuplicates =
			await this.duplicateHandler.findPotentialDuplicates(luaMetadata.docProps);

		let targetFile: TFile | null = null;
		let content: string | null = null; // lazily generated

		/* ── Case A: duplicates found ─────────────────────── */
		if (potentialDuplicates.length > 0) {
			const analyses: DuplicateMatch[] = await Promise.all(
				potentialDuplicates.map((file) =>
					this.duplicateHandler.analyzeDuplicate(
						file,
						luaMetadata.annotations,
						luaMetadata,
					),
				),
			);
			analyses.sort(
				(a, b) =>
					a.newHighlights +
					a.modifiedHighlights -
					(b.newHighlights + b.modifiedHighlights),
			);
			const bestMatch = analyses[0];

			// Check for snapshot before attempting auto-merge
			const snapshotExists = await this.snapshotManager.getSnapshotContent(
				bestMatch.file,
			);

			if (
				this.plugin.settings.autoMergeOnAddition &&
				bestMatch.matchType === "updated" &&
				bestMatch.modifiedHighlights === 0 &&
				snapshotExists // <-- THE CRITICAL SAFETY CHECK
			) {
				logger.info(
					`ImportManager: Auto-merging additions into ${bestMatch.file.path} via safe 3-way merge.`,
				);
				const { file } = await this.duplicateHandler.handleDuplicate(
					bestMatch,
					luaMetadata.annotations,
					luaMetadata,
					async () => {
						if (content === null) {
							content = await this.generateFileContent(luaMetadata);
						}
						return content;
					},
					true, // Pass isAutoMerge = true
				);
				targetFile = file;
				if (targetFile) result.automerged++;
			} else {
				if (
					!snapshotExists &&
					this.plugin.settings.autoMergeOnAddition &&
					bestMatch.matchType === "updated"
				) {
					logger.info(
						`ImportManager: Skipping auto-merge for ${bestMatch.file.path} because no snapshot exists for a safe 3-way merge.`,
					);
				}

				const { choice, file } = await this.duplicateHandler.handleDuplicate(
					bestMatch,
					luaMetadata.annotations,
					luaMetadata,
					async () => {
						content ??= await this.generateFileContent(luaMetadata);
						return content;
					},
					false, // Pass isAutoMerge = false for manual prompt
				);

				switch (choice) {
					case "merge":
					case "replace":
						result.merged++;
						targetFile = file;
						break;
					case "skip":
						result.skipped++;
						break;
					case "automerge":
						result.automerged++;
						targetFile = file;
						break;
					case "keep-both":
						break;
				}
			}
		}

		/* ── Case B: need to create a new file ────────────── */
		// Only create a new file if no duplicate was handled (merged, replaced, skipped, automerged)
		// AND the choice was not 'keep-both' (which implies new file creation).
		if (
			!targetFile &&
			result.skipped === 0 &&
			result.merged === 0 &&
			result.automerged === 0
		) {
			content ??= await this.generateFileContent(luaMetadata);

			const fileName = generateObsidianFileName(
				luaMetadata.docProps,
				this.plugin.settings.highlightsFolder,
				luaMetadata.originalFilePath,
			);

			targetFile = await createFileSafely(
				this.app.vault,
				this.plugin.settings.highlightsFolder,
				fileName.replace(/\.md$/, ""), // stem
				content,
			);
			result.created++;
		}

		/* ── Update DB if something was actually written ─── */
		if (targetFile) {
			await this.databaseService.upsertBook(
				luaMetadata.statistics?.book.id ?? null,
				bookKey,
				luaMetadata.docProps.title,
				luaMetadata.docProps.authors,
				targetFile.path,
			);
			// Create a snapshot for the next import
			await this.snapshotManager.createSnapshot(targetFile);
		}

		return result;
	}

	/* ---------------------- helper: content gen ----------------------- */
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

	/* ---------------------- helper: write file ------------------------ */
	private async createOrUpdateFile(
		filePath: string,
		content: string,
	): Promise<TFile> {
		await ensureParentDirectory(this.app.vault, filePath);

		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			logger.info(`ImportManager: Modifying existing file: ${filePath}`);
			await this.app.vault.modify(existing, content);
			return existing;
		} else {
			logger.info(`ImportManager: Creating new file: ${filePath}`);
			return await this.app.vault.create(filePath, content);
		}
	}
}
