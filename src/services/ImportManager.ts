import path from "node:path";
import { type App, Notice, TFile, type TFolder } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { getFileNameWithoutExt } from "src/utils/formatUtils";
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
import type ImportIndexService from "./vault/ImportIndexService";
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
		private readonly importIndexService: ImportIndexService,
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

		// Load the import index at the start of the import
		await this.importIndexService.load();

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
		// lastDeviceTimestamp is deprecated; keep variable for minimal churn but unused in logic
		let latestTimestampThisSession =
			this.plugin.settings.lastDeviceTimestamp ?? "";

		try {
			const results = await runPoolWithProgress(this.app, metadataFilePaths, {
				maxConcurrent: 6,
				task: async (metadataPath) =>
					this.processMetadataFile(metadataPath, session),
			});

			for (const r of results) {
				summary = addSummary(summary, r.fileSummary);
				if (
					r.latestTimestampInFile &&
					r.latestTimestampInFile > latestTimestampThisSession
				) {
					latestTimestampThisSession = r.latestTimestampInFile;
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
			// Always save the import index at the end
			await this.importIndexService.save();
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
	 * Processes a single SDR directory to extract and save highlights.
	 * @param sdrPath - Path to the SDR directory containing metadata.lua
	 * @returns Summary object with counts of created, merged, skipped, and error items
	 */
	private async processMetadataFile(
		metadataPath: string,
		session: DuplicateHandlingSession,
	): Promise<{ fileSummary: Summary; latestTimestampInFile: string | null }> {
		const summary = blankSummary();
		let latestTimestampInFile: string | null = null;

		try {
			// 1) Gather stats (used for index update and diagnostics), but do not early-exit on them
			const stats = await this.fs.getNodeStats(metadataPath);
			const previous = this.importIndexService.getEntry(metadataPath);

			// 2) Parse and process
			const sdrPath = path.dirname(metadataPath);
			const luaMetadata = await this.metadataParser.parseFile(sdrPath);
			if (!luaMetadata?.annotations?.length) {
				this.log.info(`Skipping – no annotations found in ${sdrPath}`);
				summary.skipped++;
				return { fileSummary: summary, latestTimestampInFile: null };
			}

			type Annotation = (typeof luaMetadata.annotations)[number];
			const newestAnnotation =
				luaMetadata.annotations.reduce<Annotation | null>(
					(newest, current) =>
						!newest || current.datetime > newest.datetime ? current : newest,
					null,
				);
			if (newestAnnotation) {
				latestTimestampInFile = newestAnnotation.datetime;
			}

			// Determine if we should skip based on both file mtime and newest annotation timestamp
			const isFileModifiedOnDevice =
				!!stats && !!previous ? stats.mtime.getTime() > previous.mtime : false;
			const hasNewerAnnotations =
				latestTimestampInFile && previous
					? latestTimestampInFile > (previous.newestAnnotationTimestamp ?? "")
					: true;

			if (previous && !isFileModifiedOnDevice && !hasNewerAnnotations) {
				this.log.info(`Skipping unchanged file: ${metadataPath}`);
				summary.skipped++;
				return { fileSummary: summary, latestTimestampInFile };
			}

			await this.enrichWithStatistics(luaMetadata);

			if (!luaMetadata.docProps.title) {
				luaMetadata.docProps.title = getFileNameWithoutExt(sdrPath);
				this.log.warn(
					`Metadata missing title for ${sdrPath}, using filename as fallback.`,
				);
			}

			const fileSummary = await this.saveHighlightsToFile(luaMetadata, session);

			// 3) Update index if created/merged/automerged
			if (latestTimestampInFile) {
				this.importIndexService.updateEntry(metadataPath, {
					mtime: stats ? stats.mtime.getTime() : 0,
					size: stats ? stats.size : 0,
					newestAnnotationTimestamp: latestTimestampInFile,
				});
			}

			return { fileSummary, latestTimestampInFile };
		} catch (err) {
			this.log.error(`Error processing ${metadataPath}`, err as Error);
			summary.errors++;
			return { fileSummary: summary, latestTimestampInFile };
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
		this.log.info(`Enriched metadata for "${title}" with stats DB info.`);
	}

	/**
	 * Saves highlights to a markdown file, handling duplicates appropriately.
	 * Creates snapshots for future 3-way merges and updates the database.
	 * @param luaMetadata - The metadata containing highlights to save
	 * @returns Summary object with counts of the operation results
	 */
	private async saveHighlightsToFile(
		luaMetadata: LuaMetadata,
		session: DuplicateHandlingSession,
	): Promise<Summary> {
		const summary = blankSummary();

		// Create a lazy provider for the file content
		const contentProvider = () => this.generateFileContent(luaMetadata);

		const { match: bestMatch, timedOut } =
			await this.duplicateFinder.findBestMatch(luaMetadata);

		let result: { status: string; file: TFile | null };

		if (!bestMatch) {
			// No match found
			if (timedOut) {
				// Incomplete scan – do NOT silently create a new file.
				const userChoice = await this.promptUserOnTimeout(
					luaMetadata.docProps.title || "Unknown title",
				);
				if (userChoice === "skip") {
					result = { status: "skipped", file: null };
				} else {
					// import-anyway: create with warning
					const newFile = await this.createNewFile(
						luaMetadata,
						contentProvider,
						{ withTimeoutWarning: true },
					);
					result = { status: "created", file: newFile };
				}
			} else {
				const newFile = await this.createNewFile(luaMetadata, contentProvider);
				result = { status: "created", file: newFile };
			}
		} else {
			// We have a match; handle normally. We can optionally log timeout occurrence.
			if (timedOut) {
				this.log.warn(
					`Duplicate scan timed out for "${luaMetadata.docProps.title}" but a likely match was found.`,
				);
			}
			result = await this.duplicateHandler.handleDuplicate(
				bestMatch,
				contentProvider,
				session,
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

		// Timestamp filtering and settings writes removed from here.
		return summary;
	}

	/**
	 * Prompt user when duplicate scan timed out without finding a match.
	 * Returns 'skip' or 'import-anyway'.
	 */
	private async promptUserOnTimeout(
		title: string,
	): Promise<"skip" | "import-anyway"> {
		// Reuse PromptModal for a simple two-option decision.
		const { PromptModal } = await import("../ui/PromptModal");
		return await new Promise<"skip" | "import-anyway">((resolve) => {
			// Using `unknown` here to avoid unsafe any while constructing the modal.
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
				"Duplicate scan timed out",
				[
					{
						label: "Skip this book",
						callback: () => resolve("skip"),
					},
					{
						label: "Import anyway (add warning)",
						isCta: true,
						callback: () => resolve("import-anyway"),
					},
				],
				`The duplicate scan for “${title}” did not complete within the configured timeout.\nTo avoid accidental duplicates:\n• Choose “Skip this book” to review and retry later.\n• Or “Import anyway” to create the note with a warning and needs-review flag.`,
			);
			modal.open();
		});
	}

	private async createNewFile(
		luaMetadata: LuaMetadata,
		contentProvider: () => Promise<string>,
		options?: { withTimeoutWarning?: boolean },
	): Promise<TFile> {
		let content = await contentProvider();

		// If requested, inject a prominent warning and a needs-review flag
		if (options?.withTimeoutWarning) {
			try {
				const parsed = this.frontmatterService.parseContent(content);
				// Mutate/add the needs-review flag
				const fm = parsed.frontmatter || {};
				fm["needs-review"] = "duplicate-timeout";

				// Prepend a warning callout
				const warningBlock =
					"> [!warning] Duplicate scan did not complete\n" +
					"> The scan timed out before searching the entire vault. Review this note to avoid duplicates.\n\n";

				const newBody = warningBlock + parsed.body;
				content = this.frontmatterService.reconstructFileContent(fm, newBody);
			} catch (e) {
				// Fallback: if parsing fails for any reason, still prepend a warning block
				const warningBlock =
					"---\nneeds-review: duplicate-timeout\n---\n\n" +
					"> [!warning] Duplicate scan did not complete\n" +
					"> The scan timed out before searching the entire vault. Review this note to avoid duplicates.\n\n";
				content = warningBlock + content;
				this.log.warn(
					"Failed to inject timeout warning via structured frontmatter; used fallback prepend.",
					e,
				);
			}
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
		const newBody = convertCommentStyle(body, "html", "none");
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
			counts.converted++;
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
