import path from "node:path";
import { type App, Notice, normalizePath, TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { DuplicateMatch, LuaMetadata } from "../types";
import { ProgressModal } from "../ui/ProgressModal";
import {
	ensureParentDirectory,
	generateUniqueFilePath,
} from "../utils/fileUtils";
import {
	generateObsidianFileName,
	getFileNameWithoutExt,
} from "../utils/formatUtils";
import { devError, devLog, devWarn } from "../utils/logging";
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
		devLog("Starting KOReader highlight import process…");

		const sdrPaths = await this.sdrFinder.findSdrDirectoriesWithMetadata();
		if (!sdrPaths?.length) {
			new Notice("No KOReader highlight files found (.sdr with metadata.lua).");
			devLog("No SDR files found to import.");
			return;
		}

		const modal = new ProgressModal(this.app);
		modal.open();
		modal.setTotal(sdrPaths.length);

		this.duplicateHandler.resetApplyToAll();

		const summary: Summary = { created: 0, merged: 0, automerged: 0, skipped: 0, errors: 0 };

		try {
			for (let idx = 0; idx < sdrPaths.length; idx++) {
				if (modal.abortSignal.aborted)
					throw new DOMException("Aborted by user", "AbortError");

				const sdrPath = sdrPaths[idx];
				const result = await this.processSdr(sdrPath);
				summary.created += result.created;
				summary.automerged += result.automerged;
				summary.merged += result.merged;
				summary.skipped += result.skipped;
				summary.errors += result.error ? 1 : 0;

				modal.updateProgress(idx + 1, path.basename(sdrPath));
			}

			new Notice(
				`KOReader Import finished\n${summary.created} new • ${summary.merged} merged • ${summary.skipped} skipped • ${summary.errors} error(s)`,
				10_000,
			);
			devLog("Import process finished", summary);
		} catch (err: any) {
			if (err?.name === "AbortError") {
				new Notice("Import cancelled by user.");
			} else {
				devError("Critical error during highlight import process:", err);
				new Notice("KOReader Importer: critical error. Check console.");
			}
		} finally {
			devLog("Flushing database index …");
			await this.databaseService.flushIndex();
			modal.close();
		}
	}

	async clearCaches(): Promise<void> {
		this.sdrFinder.clearCache();
		this.metadataParser.clearCache();
		this.duplicateHandler.clearCache();
		devLog("Import-related caches cleared.");
	}

	/* ------------------------------------------------------------------ */
	/*                             PRIVATE                                */
	/* ------------------------------------------------------------------ */

	private async processSdr(
		sdrPath: string,
	): Promise<Summary & { error?: any }> {
		const summary: Summary & { error?: any } = {
			created: 0,
			merged: 0,
			automerged: 0,
			skipped: 0,
			errors: 0,
		};

		try {
			/* 1 ──────────────────  Parse metadata  ───────────────────────── */
			const luaMetadata = await this.metadataParser.parseFile(sdrPath);
			if (!luaMetadata?.annotations?.length) {
				devWarn(`Skipping – no annotations: ${sdrPath}`);
				summary.skipped++;
				return summary;
			}

			/* 2 ───────────────────── Stats lookup  ───────────────────────── */
			await this.enrichWithStatistics(luaMetadata, sdrPath);

			/* 3 ───────────────────  Missing title  ───────────────────────── */
			if (!luaMetadata.docProps.title) {
				luaMetadata.docProps.title = getFileNameWithoutExt(sdrPath);
			}

			/* 4 ─────────────────  Save highlights  ───────────────────────── */
			const bookKey = this.databaseService.bookKeyFromDocProps(
				luaMetadata.docProps,
			);

			const fileSummary = await this.saveHighlightsToFile(luaMetadata, bookKey);
			Object.assign(summary, {
				created: fileSummary.created,
				merged: fileSummary.merged,
				skipped: fileSummary.skipped,
			});
		} catch (err) {
			devError(`Error processing ${sdrPath}`, err);
			summary.error = err;
			summary.errors = 1;
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
		devLog(`Corrected metadata for “${sdrPath}” from stats DB.`);
	}

	/* ---------------------- helper: save/merge ------------------------ */
	private async saveHighlightsToFile(
		luaMetadata: LuaMetadata,
		bookKey: string,
	): Promise<Summary> {
		const result: Summary = { created: 0, merged: 0, automerged: 0, skipped: 0, errors: 0 };

		const potentialDuplicates =
			await this.duplicateHandler.findPotentialDuplicates(luaMetadata.docProps);

		let targetFile: TFile | null = null;
		let content: string | null = null; // lazily generated

		/* ── Case A: duplicates found ─────────────────────── */
		if (potentialDuplicates.length > 0) {
			const analyses: DuplicateMatch[] = await Promise.all(
				potentialDuplicates.map(file => 
					this.duplicateHandler.analyzeDuplicate(file, luaMetadata.annotations, luaMetadata)
				)
			);
			analyses.sort((a, b) => (a.newHighlights + a.modifiedHighlights) - (b.newHighlights + b.modifiedHighlights));
			const bestMatch = analyses[0];
	
			if (
				this.plugin.settings.autoMergeOnAddition &&
				bestMatch.matchType === 'updated' &&
				bestMatch.modifiedHighlights === 0
			) {
				devLog(`Auto-merging additions into ${bestMatch.file.path}`);
				const { file } = await this.duplicateHandler.handleDuplicate(
					bestMatch,
					luaMetadata.annotations,
					luaMetadata,
					async () => content ??= await this.generateFileContent(luaMetadata),
				);
				targetFile = file;
				if(targetFile) result.automerged++;

			} else {
				const { choice, file } = await this.duplicateHandler.handleDuplicate(
					bestMatch,
					luaMetadata.annotations,
					luaMetadata,
					async () => {
						content ??= await this.generateFileContent(luaMetadata);
						return content;
					},
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
					case "keep-both":
						break;
				}
			}
		}

		/* ── Case B: need to create a new file ────────────── */
		if (!targetFile && result.skipped === 0 && result.automerged === 0) {
			content ??= await this.generateFileContent(luaMetadata);
	
			const fileName = generateObsidianFileName(
				luaMetadata.docProps,
				this.plugin.settings.highlightsFolder,
				luaMetadata.originalFilePath,
			);
			const targetPath = await generateUniqueFilePath(
				this.app.vault,
				this.plugin.settings.highlightsFolder,
				fileName,
			);
	
			targetFile = await this.createOrUpdateFile(targetPath, content);
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
			luaMetadata,
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
			await this.app.vault.modify(existing, content);
			return existing;
		} else {
			return await this.app.vault.create(filePath, content);
		}
	}
}