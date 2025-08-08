import { TFile, TFolder, type Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type {
	Annotation,
	DocProps,
	DuplicateMatch,
	LuaMetadata,
} from "src/types";
import type { CacheManager } from "src/utils/cache/CacheManager";
import { getHighlightKey } from "src/utils/formatUtils";
import { extractHighlights } from "src/utils/highlightExtractor";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { LocalIndexService } from "./LocalIndexService";
import type { SnapshotManager } from "./SnapshotManager";

export class DuplicateFinder {
	private readonly SCOPE = "DuplicateFinder";
	private potentialDuplicatesCache: Map<string, TFile[]>;
	// Cache frontmatter during a session to avoid reparsing on fallback scans
	private fmCache: import("src/utils/cache/LruCache").LruCache<
		string,
		{ mtime: number; title?: string; authors?: string }
	>;

	constructor(
		private vault: Vault,
		private plugin: KoreaderImporterPlugin,
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
	}

	public async findBestMatch(
		luaMetadata: LuaMetadata,
	): Promise<{ match: DuplicateMatch | null; timedOut: boolean }> {
		const { files: potentialDuplicates, timedOut } =
			await this.findPotentialDuplicates(luaMetadata.docProps);
		if (potentialDuplicates.length === 0) {
			return { match: null, timedOut };
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

		return { match: analyses[0], timedOut };
	}

	private async findPotentialDuplicates(
		docProps: DocProps,
	): Promise<{ files: TFile[]; timedOut: boolean }> {
		const bookKey = this.LocalIndexService.bookKeyFromDocProps(docProps);
		const cached = this.potentialDuplicatesCache.get(bookKey);
		if (cached) {
			this.loggingService.info(
				this.SCOPE,
				`Cache hit for potential duplicates of key: ${bookKey}`,
			);
			return { files: cached, timedOut: false };
		}

		// If the index is persistent, use the fast path (existing behavior).
		if (this.LocalIndexService.isIndexPersistent()) {
			this.loggingService.info(
				this.SCOPE,
				`Querying index for existing files with book key: ${bookKey}`,
			);
			const paths = await this.LocalIndexService.findExistingBookFiles(bookKey);
			const files = paths
				.map((p) => this.vault.getAbstractFileByPath(p))
				.filter((f): f is TFile => f instanceof TFile);

			this.potentialDuplicatesCache.set(bookKey, files);
			return { files, timedOut: false };
		}

		// Degraded mode: no persistent index. Fallback to scanning highlights folder recursively and parsing frontmatter.
		this.loggingService.info(
			this.SCOPE,
			`Degraded mode: scanning vault for potential duplicates of key: ${bookKey}`,
		);

		const settingsFolder = this.plugin.settings.highlightsFolder ?? "";
		const root = this.vault.getAbstractFileByPath(settingsFolder);
		if (!(root instanceof TFolder)) {
			this.loggingService.warn(
				this.SCOPE,
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
			this.loggingService.warn(
				this.SCOPE,
				`Degraded duplicate scan timed out after ${SCAN_TIMEOUT_MS}ms.`,
			);
			timedOut = true;
		}

		for (const file of files) {
			if (Date.now() - startTime > SCAN_TIMEOUT_MS) {
				timedOut = true;
				break;
			}
			try {
				const cache = await this.getFmCached(file);
				const fileKey = this.LocalIndexService.bookKeyFromDocProps({
					title: cache.title ?? "",
					authors: cache.authors ?? "",
				});
				if (fileKey === bookKey) {
					results.push(file);
				}
			} catch (e) {
				this.loggingService.warn(
					this.SCOPE,
					`Frontmatter parse failed for ${file.path} during duplicate scan.`,
					e,
				);
			}
		}

		this.potentialDuplicatesCache.set(bookKey, results);
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
}
