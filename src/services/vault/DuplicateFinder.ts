import { TFile, type Vault } from "obsidian";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type { CacheManager } from "src/utils/cache/CacheManager";
import { getHighlightKey } from "src/utils/formatUtils";
import { extractHighlights } from "src/utils/highlightExtractor";
import type {
	Annotation,
	DocProps,
	DuplicateMatch,
	LuaMetadata,
} from "../../types";
import type { LoggingService } from "../LoggingService";
import type { LocalIndexService } from "./LocalIndexService";
import type { SnapshotManager } from "./SnapshotManager";

export class DuplicateFinder {
	private readonly SCOPE = "DuplicateFinder";
	private potentialDuplicatesCache: Map<string, TFile[]>;

	constructor(
		private vault: Vault,
		private LocalIndexService: LocalIndexService,
		private fmService: FrontmatterService,
		private snapshotManager: SnapshotManager,
		private cacheManager: CacheManager,
		private loggingService: LoggingService,
	) {
		this.potentialDuplicatesCache = this.cacheManager.createMap(
			"duplicate.potential",
		);
	}

	public async findBestMatch(
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch | null> {
		const potentialDuplicates = await this.findPotentialDuplicates(
			luaMetadata.docProps,
		);
		if (potentialDuplicates.length === 0) {
			return null;
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

		return analyses[0];
	}

	private async findPotentialDuplicates(docProps: DocProps): Promise<TFile[]> {
		const bookKey = this.LocalIndexService.bookKeyFromDocProps(docProps);
		const cached = this.potentialDuplicatesCache.get(bookKey);
		if (cached) {
			this.loggingService.info(
				this.SCOPE,
				`Cache hit for potential duplicates of key: ${bookKey}`,
			);
			return cached;
		}

		this.loggingService.info(
			this.SCOPE,
			`Querying index for existing files with book key: ${bookKey}`,
		);
		const paths = await this.LocalIndexService.findExistingBookFiles(bookKey);
		const files = paths
			.map((p) => this.vault.getAbstractFileByPath(p))
			.filter((f): f is TFile => f instanceof TFile);

		this.potentialDuplicatesCache.set(bookKey, files);
		return files;
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
		const { body: existingBody } = this.fmService.parse(
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
	}
}
