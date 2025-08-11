import { type App, normalizePath, TFile, TFolder, type Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type {
	Annotation,
	DocProps,
	DuplicateMatch,
	DuplicateScanResult,
	LuaMetadata,
} from "src/types";
import type { CacheManager } from "src/utils/cache/CacheManager";
import {
	expectedNameKeysFromDocProps,
	keysMatchLoose,
	nameKeyFromBasename,
} from "src/utils/filenameMatcher";
import { bookKeyFromDocProps, getHighlightKey } from "src/utils/formatUtils";
import { extractHighlights } from "src/utils/highlightExtractor";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { FileNameGenerator } from "./FileNameGenerator";
import type { LocalIndexService } from "./LocalIndexService";
import type { SnapshotManager } from "./SnapshotManager";

export class DuplicateFinder {
	private readonly log;
	private potentialDuplicatesCache: Map<string, TFile[]>;
	// Cache frontmatter during a session to avoid reparsing on fallback scans
	private fmCache: import("src/utils/cache/LruCache").LruCache<
		string,
		{ mtime: number; title?: string; authors?: string }
	>;

	constructor(
		private app: App,
		private vault: Vault,
		private plugin: KoreaderImporterPlugin,
		private fileNameGenerator: FileNameGenerator,
		private LocalIndexService: LocalIndexService,
		private fmService: FrontmatterService,
		private snapshotManager: SnapshotManager,
		private cacheManager: CacheManager,
		private loggingService: LoggingService,
		private fs: FileSystemService,
	) {
		this.potentialDuplicatesCache = this.cacheManager.createMap(
			"duplicate.potential",
		);
		this.fmCache = this.cacheManager.createLru("duplicate.fm", 500);

		this.log = this.loggingService.scoped("DuplicateFinder");
	}

	public async findBestMatch(
		luaMetadata: LuaMetadata,
	): Promise<DuplicateScanResult> {
		// Step 1: Instant probe for exact expected filename
		try {
			const expectedFileName = this.fileNameGenerator.generate(
				{
					useCustomTemplate: this.plugin.settings.useCustomFileNameTemplate,
					template: this.plugin.settings.fileNameTemplate,
					highlightsFolder: this.plugin.settings.highlightsFolder,
				},
				luaMetadata.docProps,
				luaMetadata.originalFilePath,
			);
			const expectedPath = normalizePath(
				`${this.plugin.settings.highlightsFolder}/${expectedFileName}`,
			);
			const direct = this.app.vault.getAbstractFileByPath(expectedPath);
			if (direct instanceof TFile) {
				const analysis = await this.analyzeDuplicate(
					direct,
					luaMetadata.annotations,
					luaMetadata,
				);
				this.log.info(
					`Found instant duplicate match via expected filename: ${expectedPath}`,
				);
				return { match: analysis, confidence: "full" };
			}
		} catch (e) {
			this.log.warn("Instant filename probe failed (continuing with scan)", e);
		}

		const { files: potentialDuplicates, timedOut } =
			await this.findPotentialDuplicates(luaMetadata.docProps);
		if (potentialDuplicates.length === 0) {
			return { match: null, confidence: timedOut ? "partial" : "full" };
		}

		const analyses: DuplicateMatch[] = await Promise.all(
			potentialDuplicates.map((file) =>
				this.analyzeDuplicate(file, luaMetadata.annotations, luaMetadata),
			),
		);

		// Sort to find the "best" match, defined as the one with the fewest changes.
		analyses.sort(
			(a, b) =>
				a.newHighlights +
				a.modifiedHighlights -
				(b.newHighlights + b.modifiedHighlights),
		);

		return {
			match: analyses[0],
			confidence: timedOut ? "partial" : "full",
		};
	}

	private async findPotentialDuplicates(
		docProps: DocProps,
	): Promise<{ files: TFile[]; timedOut: boolean }> {
		const bookKey = bookKeyFromDocProps(docProps);
		const cached = this.potentialDuplicatesCache.get(bookKey);
		if (cached) {
			this.log.info(`Cache hit for potential duplicates of key: ${bookKey}`);
			return { files: cached, timedOut: false };
		}

		// Wait for the index to be minimally ready to avoid race conditions.
		await this.LocalIndexService.whenReady();

		// Always query the index first.
		this.log.info(
			`Querying index for existing files with book key: ${bookKey}`,
		);
		const paths = await this.LocalIndexService.findExistingBookFiles(bookKey);
		const filesFromIndex = paths
			.map((p) => this.vault.getAbstractFileByPath(p))
			.filter((f): f is TFile => f instanceof TFile);

		// If persistent, trust results fully.
		if (this.LocalIndexService.isIndexPersistent()) {
			this.potentialDuplicatesCache.set(bookKey, filesFromIndex);
			return { files: filesFromIndex, timedOut: false };
		}

		// If in-memory and we found candidates, return them.
		if (filesFromIndex.length > 0) {
			this.potentialDuplicatesCache.set(bookKey, filesFromIndex);
			return { files: filesFromIndex, timedOut: false };
		}

		// Degraded mode fallback scan:
		// Phase 1: scan using metadataCache.frontmatter (no file I/O)
		// Phase 2: for uncached candidates, targeted file reads within time budget
		this.log.info(
			`Index is in-memory and yielded no results for key ${bookKey}. Falling back to vault scan.`,
		);

		const settingsFolder = this.plugin.settings.highlightsFolder ?? "";
		const root = this.vault.getAbstractFileByPath(settingsFolder);
		if (!(root instanceof TFolder)) {
			this.log.warn(
				`Highlights folder not found or not a directory: '${settingsFolder}'`,
			);
			return { files: [], timedOut: false };
		}

		const results: TFile[] = [];
		const startTime = Date.now();
		const SCAN_TIMEOUT_MS =
			(this.plugin.settings.scanTimeoutSeconds ?? 8) * 1000;
		let timedOut = false;

		const { files, aborted } = await this.fs.getFilesInFolder(root, {
			extensions: ["md"],
			recursive: true,
			signal: undefined,
		});
		if (aborted || Date.now() - startTime > SCAN_TIMEOUT_MS) {
			this.log.warn(
				`Degraded duplicate scan timed out after ${SCAN_TIMEOUT_MS}ms.`,
			);
			return { files: [], timedOut: true };
		}

		// Prepare fuzzy expected keys from intended filename composition
		const expectedKeys = expectedNameKeysFromDocProps(
			docProps,
			this.plugin.settings.useCustomFileNameTemplate,
			this.plugin.settings.fileNameTemplate,
		);

		for (const file of files) {
			if (Date.now() - startTime > SCAN_TIMEOUT_MS) {
				timedOut = true;
				break;
			}
			try {
				// Phase 1: try metadataCache (no disk I/O)
				const md = this.app.metadataCache.getFileCache(file);
				const fm = md?.frontmatter as any | undefined;
				let title: string | undefined;
				let authors: string | undefined;
				if (fm) {
					title = typeof fm.title === "string" ? fm.title : undefined;
					if (typeof fm.authors === "string") authors = fm.authors;
					else if (Array.isArray(fm.authors)) authors = fm.authors.join(", ");
				}

				// If metadataCache lacks needed fields, fall back to targeted file read
				if (!title && !authors) {
					const cachedFm = await this.getFmCached(file);
					title = cachedFm.title;
					authors = cachedFm.authors;
				}

				const fileKey = bookKeyFromDocProps({
					title: title ?? "",
					authors: authors ?? "",
				});
				const matchedByFrontmatter = fileKey === bookKey;
				if (matchedByFrontmatter) {
					results.push(file);
				} else {
					// Fallback: fuzzy match by filename key if frontmatter didn't match
					const fileStemKey = nameKeyFromBasename(file.basename);
					if (expectedKeys.some((ek) => keysMatchLoose(ek, fileStemKey))) {
						results.push(file);
					}
				}
			} catch (e) {
				this.log.warn(
					`Frontmatter parse failed for ${file.path} during duplicate scan.`,
					e,
				);
			}
		}

		if (!timedOut) {
			this.potentialDuplicatesCache.set(bookKey, results);
		}
		return { files: results, timedOut };
	}

	/**
	 * Analyzes an existing file to determine how it differs from new annotations.
	 * Counts new and modified highlights to classify the duplicate type.
	 * @param existingFile - The existing file to analyze
	 * @param newAnnotations - New annotations from KOReader
	 * @param luaMetadata - Complete metadata for the new import
	 * @returns DuplicateMatch object with analysis results
	 */
	private async analyzeDuplicate(
		existingFile: TFile,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch> {
		const { body: existingBody } = this.fmService.parseContent(
			await this.vault.read(existingFile),
		);
		const existingHighlights = extractHighlights(existingBody);

		let newHighlightCount = 0;
		let modifiedHighlightCount = 0;

		const existingHighlightsMap = new Map(
			existingHighlights.map((h) => [getHighlightKey(h), h]),
		);

		for (const newHighlight of newAnnotations) {
			const key = getHighlightKey(newHighlight);
			const existingMatch = existingHighlightsMap.get(key);

			if (!existingMatch) {
				newHighlightCount++;
			} else {
				const textModified =
					this.normalizeForComparison(existingMatch.text) !==
					this.normalizeForComparison(newHighlight.text);
				const noteModified =
					this.normalizeForComparison(existingMatch.note) !==
					this.normalizeForComparison(newHighlight.note);
				if (textModified || noteModified) {
					modifiedHighlightCount++;
				}
			}
		}

		const matchType = this.determineMatchType(
			newHighlightCount,
			modifiedHighlightCount,
		);
		const canMergeSafely =
			(await this.snapshotManager.getSnapshotContent(existingFile)) !== null;

		return {
			file: existingFile,
			matchType,
			newHighlights: newHighlightCount,
			modifiedHighlights: modifiedHighlightCount,
			luaMetadata,
			canMergeSafely,
		};
	}

	/**
	 * Determines the type of duplicate match based on differences.
	 * @param newCount - Number of new highlights
	 * @param modifiedCount - Number of modified highlights
	 * @returns Match type: "exact", "updated", or "divergent"
	 */
	private determineMatchType(
		newCount: number,
		modifiedCount: number,
	): DuplicateMatch["matchType"] {
		if (newCount === 0 && modifiedCount === 0) return "exact";
		if (modifiedCount > 0) return "divergent";
		if (newCount > 0) return "updated";
		return "exact";
	}

	private normalizeForComparison(text?: string): string {
		return text?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
	}

	public clearCache(): void {
		this.potentialDuplicatesCache.clear();
		this.fmCache.clear();
	}

	private async getFmCached(
		file: TFile,
	): Promise<{ mtime: number; title?: string; authors?: string }> {
		const prev = this.fmCache.get(file.path);
		const mtime = file.stat.mtime;
		if (prev && prev.mtime === mtime) return prev;
		const { frontmatter } = await this.fmService.parseFile(file);
		const curr = {
			mtime,
			title: String(frontmatter?.title ?? ""),
			authors: String(frontmatter?.authors ?? ""),
		};
		this.fmCache.set(file.path, curr);
		return curr;
	}

	/**
	 * Public wrapper to analyze a known existing file against provided lua metadata.
	 * Reuses the internal analyzeDuplicate logic so the modal shows accurate stats
	 * and merge capability.
	 */
	public async analyzeExistingFile(
		existingFile: TFile,
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch> {
		return this.analyzeDuplicate(
			existingFile,
			luaMetadata.annotations,
			luaMetadata,
		);
	}
}
