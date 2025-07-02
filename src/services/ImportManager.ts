import path from "node:path";
import { type App, normalizePath, Notice, TFile } from "obsidian";
import type {
	Annotation,
	DuplicateChoice,
	KoreaderHighlightImporterSettings,
	LuaMetadata,
} from "../types";
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

export class ImportManager {
	constructor(
		private app: App,
		private settings: KoreaderHighlightImporterSettings,
		private sdrFinder: SDRFinder,
		private metadataParser: MetadataParser,
		private databaseService: DatabaseService,
		private frontmatterGenerator: FrontmatterGenerator,
		private contentGenerator: ContentGenerator,
		private duplicateHandler: DuplicateHandler,
	) {}

	async importHighlights(): Promise<void> {
		devLog("Starting KOReader highlight import process...");

		const modal = new ProgressModal(this.app);
		modal.open();

		try {
			const sdrFilePaths =
				await this.sdrFinder.findSdrDirectoriesWithMetadata();
			if (!sdrFilePaths || sdrFilePaths.length === 0) {
				new Notice(
					"No KOReader highlight files (.sdr directories with metadata.lua) found.",
				);
				devLog("No SDR files found to import.");
				modal.close();
				return;
			}

			const totalFiles = sdrFilePaths.length;
			modal.setTotal(totalFiles);
			devLog(`Found ${totalFiles} SDR files to process.`);
			let completed = 0;
			let errors = 0;
			let created = 0;
			let merged = 0;
			let skipped = 0;

			// Reset duplicate handler state for this import session
			this.duplicateHandler.resetApplyToAll();

			for (const sdrPath of sdrFilePaths) {
				const baseName = path.basename(sdrPath);
				modal.updateProgress(completed, baseName);
				devLog(`Processing SDR: ${sdrPath}`);

				try {
					// 1. Parse Metadata
					const luaMetadata = await this.metadataParser.parseFile(sdrPath);
					if (!luaMetadata) {
						devWarn(
							`Skipping SDR due to parsing error or no metadata: ${sdrPath}`,
						);
						errors++;
						continue;
					}

					// 2. Fetch Statistics
					if (this.settings.frontmatter) {
						try {
							const stats = await this.databaseService.getBookStatistics(
								luaMetadata.docProps.authors,
								luaMetadata.docProps.title,
							);
							if (stats) {
								luaMetadata.statistics = stats;
								devLog(
									`Successfully fetched statistics for: ${luaMetadata.docProps.title}`,
								);
							} else {
								devLog(
									`No statistics found for: ${luaMetadata.docProps.title}`,
								);
							}
						} catch (statError) {
							// Non-critical error, log and continue
							devError(
								`Non-critical error fetching stats for ${luaMetadata.docProps.title}:`,
								statError,
							);
						}
					}

					// 3. Handle missing Title gracefully (leave authors empty)
					if (!luaMetadata.docProps.title) {
						const fallbackName = getFileNameWithoutExt(sdrPath);
						luaMetadata.docProps.title = fallbackName;
						devLog(
							`Metadata was missing a title. Using fallback name "${fallbackName}" for the title.`,
						);
					}

					// 4. Save Highlights and get summary
					const fileSummary = await this.saveHighlightsToFile(
						luaMetadata,
						path.basename(sdrPath),
					);

					// Update summary counts
					created += fileSummary.created;
					merged += fileSummary.merged;
					skipped += fileSummary.skipped;
				} catch (fileError) {
					this.handleFileError(fileError, sdrPath);
					errors++;
				} finally {
					completed++;
					modal.updateProgress(completed, baseName); // Update progress even on error
				}
			}

			// ---------- MULTI-LINE SUMMARY NOTICE -------------
			const noticeMsg = `KOReader Import finished
${created} new • ${merged} merged • ${skipped} skipped • ${errors} error(s)`;
			new Notice(noticeMsg);
			// ------------------------------------------------------

			devLog(
				`Import process finished. Processed: ${completed}, Errors: ${errors}`,
			);
		} catch (error) {
			devError("Critical error during highlight import process:", error);
			new Notice(
				"KOReader Importer: Critical error during import. Check console.",
			);
		} finally {
			modal.close();
		}
	}

	private async saveHighlightsToFile(
		luaMetadata: LuaMetadata,
		originalSdrName: string,
	): Promise<{ created: number; merged: number; skipped: number }> {
		const summary = { created: 0, merged: 0, skipped: 0 };
		const annotations = luaMetadata.annotations || [];
		if (annotations.length === 0) {
			devLog(
				`No annotations found for "${luaMetadata.docProps.title}". Skipping file creation.`,
			);
			summary.skipped++;
			return summary;
		}

		// 1. Generate File Name
		const fileName = generateObsidianFileName(
			luaMetadata.docProps,
			this.settings.highlightsFolder,
			originalSdrName,
		);
		const targetFilePath = normalizePath(
			`${this.settings.highlightsFolder}/${fileName}`,
		);

		// 2. Generate Content
		const frontmatterString =
			this.frontmatterGenerator.generateYamlFromLuaMetadata(
				luaMetadata,
				this.settings.frontmatter,
			);
		const highlightsContent =
			await this.contentGenerator.generateHighlightsContent(
				annotations,
				luaMetadata,
			);
		const fullContent = `${frontmatterString}\n\n${highlightsContent}`;

		devLog(`Generated content for: ${fileName}`);

		// 3. Handle Duplicates & Save
		const potentialDuplicates =
			await this.duplicateHandler.findPotentialDuplicates(luaMetadata.docProps);

		if (potentialDuplicates.length > 0) {
			devLog(
				`Found ${potentialDuplicates.length} potential duplicate(s) for: ${fileName}`,
			);

			const choice = await this.processDuplicates(
				potentialDuplicates,
				annotations,
				luaMetadata,
				fullContent,
				targetFilePath,
			);

			// A choice was made by the user or by "Apply to all"
			if (choice) {
				switch (choice) {
					case "replace":
					case "merge":
						summary.merged++;
						break;
					case "keep-both":
						summary.created++;
						break;
					case "skip":
						summary.skipped++;
						break;
				}
				devLog(
					`Action '${choice}' handled by DuplicateHandler. Returning summary.`,
				);
				return summary;
			} else {
				// No choice was made (e.g., modal was cancelled/closed)
				devLog(
					`No choice made for duplicate "${luaMetadata.docProps.title}". Skipping.`,
				);
				summary.skipped++;
				return summary;
			}
		}

		// Only create new file if no duplicates were found
		const outcome = await this.createOrUpdateFile(targetFilePath, fullContent);
		if (outcome === "created") summary.created++;
		else summary.merged++;

		return summary;
	}

	private async processDuplicates(
		potentialDuplicates: TFile[],
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
		newContent: string,
		intendedTargetPath: string,
	): Promise<DuplicateChoice | null> {
		for (const existingFile of potentialDuplicates) {
			devLog(`Analyzing duplicate: ${existingFile.path}`);
			const analysis = await this.duplicateHandler.analyzeDuplicate(
				existingFile,
				newAnnotations,
				luaMetadata,
			);

			const { choice, applyToAll } =
				await this.duplicateHandler.handleDuplicate(
					analysis,
					newAnnotations,
					luaMetadata,
					newContent,
				);

			// Return all choices including 'keep-both'
			if (choice) {
				return choice;
			}
		}
		return null;
	}

	private async createOrUpdateFile(
		filePath: string,
		content: string,
	): Promise<"created" | "modified"> {
		try {
			try {
				await ensureParentDirectory(this.app.vault, filePath);
			} catch (error) {
				devError(
					`Failed to ensure parent directory for ${filePath}. Aborting file creation.`,
					error,
				);
				new Notice(`Could not create folder for: ${path.basename(filePath)}`);
				throw error; // Re-throw to be caught by the outer catch block
			}
			const file = this.app.vault.getAbstractFileByPath(filePath);

			if (file instanceof TFile) {
				devLog(`Modifying existing file: ${filePath}`);
				await this.app.vault.modify(file, content);
				return "modified";
			} else {
				const uniqueFilePath = await generateUniqueFilePath(
					this.app.vault,
					this.settings.highlightsFolder,
					path.basename(filePath),
				);
				if (uniqueFilePath !== filePath) {
					devLog(
						`Target path ${filePath} existed, saving to unique path: ${uniqueFilePath}`,
					);
				} else {
					devLog(`Creating new file: ${uniqueFilePath}`);
				}
				await this.app.vault.create(uniqueFilePath, content);
				return "created";
			}
		} catch (error) {
			devError(`Error creating/updating file ${filePath}:`, error);
			new Notice(`Failed to save file: ${path.basename(filePath)}`);
			throw error;
		}
	}

	private handleFileError(error: unknown, filePath: string): void {
		const baseName = path.basename(filePath);
		if (error instanceof Error) {
			devError(
				`Error processing file ${baseName}: ${error.message}`,
				error.stack,
			);
			new Notice(`Error processing ${baseName}. See console.`);
		} else {
			devError(`Unknown error processing file ${baseName}:`, error);
			new Notice(`Unknown error processing ${baseName}. See console.`);
		}
	}

	async clearCaches(): Promise<void> {
		this.sdrFinder.clearCache();
		this.metadataParser.clearCache();
		this.duplicateHandler.clearCache();
		devLog("Import-related caches cleared.");
	}
}
