import path from "node:path";
import {
	type App,
	type CachedMetadata,
	type Plugin,
	type TAbstractFile,
	TFile,
	type Vault,
} from "obsidian";
import type {
	Annotation,
	DocProps,
	DuplicateChoice,
	DuplicateMatch,
	IDuplicateHandlingModal,
	KoreaderHighlightImporterSettings,
	LuaMetadata,
	ParsedFrontmatter,
} from "../types";
import { generateUniqueFilePath } from "../utils/fileUtils";
import {
	compareAnnotations,
	normalizeFileNamePiece,
} from "../utils/formatUtils";
import { extractHighlights } from "../utils/highlightExtractor";
import { devLog, devWarn } from "../utils/logging";
import type { ContentGenerator } from "./ContentGenerator";
import type { FrontmatterGenerator } from "./FrontmatterGenerator";

type CacheKey = string;
type PotentialDuplicatesCache = Map<CacheKey, TFile[]>;

export class DuplicateHandler {
	private frontmatterGenerator: FrontmatterGenerator;
	currentMatch: NonNullable<DuplicateMatch> | null = null;
	private applyToAll = false;
	private applyToAllChoice: DuplicateChoice | null = null;
	private potentialDuplicatesCache: PotentialDuplicatesCache = new Map();
	private globalVaultIndex: Map<CacheKey, Set<TFile>> = new Map();
	private isGlobalIndexBuilt = false;
	private fileToKey: Map<string, CacheKey> = new Map();

	/** Normalises a title/author string for comparisons and cache keys. */
	private static normalizeNamePart(str: string | undefined): string {
		return normalizeFileNamePiece(str || "").toLowerCase();
	}

	/** Builds the canonical cache key from document properties. */
	private static buildCacheKeyFromDocProps(props: DocProps): CacheKey {
		return `${DuplicateHandler.normalizeNamePart(props.authors)}::${DuplicateHandler.normalizeNamePart(
			props.title,
		)}`;
	}

	constructor(
		private vault: Vault,
		private app: App,
		private modalFactory: (
			app: App,
			match: DuplicateMatch,
			message: string,
		) => IDuplicateHandlingModal,
		private settings: KoreaderHighlightImporterSettings,
		frontmatterGeneratorInstance: FrontmatterGenerator,
		private plugin: Plugin,
		private contentGenerator: ContentGenerator,
	) {
		this.registerMetadataCacheEvents();
		this.frontmatterGenerator = frontmatterGeneratorInstance;

		// Register listeners and let Obsidian dispose them automatically
		this.plugin.registerEvent(
			this.app.metadataCache.on("changed", this.handleMetadataChange, this),
		);
		this.plugin.registerEvent(
			this.app.metadataCache.on("deleted", this.handleFileDeletion, this),
		);
		this.plugin.registerEvent(
			this.app.vault.on("rename", this.handleFileRename, this),
		);
	}

	private registerMetadataCacheEvents(): void {
		devLog("DuplicateHandler: Registered metadata cache listeners.");
	}

	// --- Cache Invalidation Handlers ---

	private handleMetadataChange(
		file: TFile,
		_data: string,
		cache: CachedMetadata,
	): void {
		if (!this.settings.enableFullDuplicateCheck) return;

		// Update a single file instead of dropping everything
		this.indexFile(file);
	}

	private handleFileDeletion(file: TFile): void {
		if (!this.settings.enableFullDuplicateCheck) return;

		this.unindexFile(file.path);
	}

	private handleFileRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) return;

		// Remove old path from index immediately
		this.unindexFile(oldPath);
	}

	/** Resets the "Apply to All" state. Call before starting a new batch import. */
	public resetApplyToAll(): void {
		this.applyToAll = false;
		this.applyToAllChoice = null;
		this.currentMatch = null;
		devLog("DuplicateHandler 'Apply to All' state reset.");
	}

	/** Clears the internal cache of potential duplicates. */
	public clearCache(): void {
		this.potentialDuplicatesCache.clear();
		devLog("DuplicateHandler potential duplicates cache cleared.");
	}

	async handleDuplicate(
		analysis: DuplicateMatch,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
		newContent: string,
	): Promise<{ choice: DuplicateChoice | null; applyToAll: boolean }> {
		let choice: DuplicateChoice | null;

		if (this.applyToAllChoice) {
			choice = this.applyToAllChoice;
		} else {
			const modal = this.modalFactory(
				this.app,
				analysis,
				"Duplicate detected – choose an action",
			);
			const res = await modal.openAndGetChoice();
			choice = res.choice;
			if (res.applyToAll && choice) this.applyToAllChoice = choice;
		}

		if (!choice) {
			// default to 'replace' for 'exact' or 'updated' matches
			choice =
				analysis.matchType === "exact" || analysis.matchType === "updated"
					? "replace"
					: "skip";
		}

		if (choice) {
			await this.executeChoice(
				analysis.file,
				choice,
				newAnnotations,
				luaMetadata,
				newContent,
			);
		}

		return { choice, applyToAll: Boolean(this.applyToAllChoice) };
	}

	async findPotentialDuplicates(docProps: DocProps): Promise<TFile[]> {
		const cacheKey = this.getCacheKey(docProps);

		// First check the session cache
		if (this.potentialDuplicatesCache.has(cacheKey)) {
			devLog(`Session cache hit for potential duplicates: ${cacheKey}`);
			return [...(this.potentialDuplicatesCache.get(cacheKey) || [])];
		}

		// If full vault checking is enabled, use or build the global index
		if (this.settings.enableFullDuplicateCheck) {
			// Build the index if it's not built yet
			if (!this.isGlobalIndexBuilt) {
				await this.buildGlobalVaultIndex();
			}

			// Use the global index for lookup
			if (this.globalVaultIndex.has(cacheKey)) {
				const matches = [...(this.globalVaultIndex.get(cacheKey) || [])];
				// Also update the session cache
				this.potentialDuplicatesCache.set(cacheKey, [...matches]);
				devLog(`Global index hit for potential duplicates: ${cacheKey}`);
				return matches;
			}

			// No matches in global index
			devLog(`No matches found in global index for: ${cacheKey}`);
			this.potentialDuplicatesCache.set(cacheKey, []);
			return [];
		}

		devLog(`Searching in highlights folder for: ${cacheKey}`);

		const filesToCheck = this.app.vault
			.getFiles()
			.filter(
				(file): file is TFile =>
					file instanceof TFile &&
					file.path.startsWith(`${this.settings.highlightsFolder}/`) &&
					file.extension === "md",
			);

		const potentialDuplicates: TFile[] = [];
		for (const file of filesToCheck) {
			const metadata = this.app.metadataCache.getFileCache(file);
			if (this.isMetadataMatch(metadata?.frontmatter, docProps)) {
				potentialDuplicates.push(file);
			}
		}

		this.potentialDuplicatesCache.set(cacheKey, [...potentialDuplicates]);
		return potentialDuplicates;
	}

	async analyzeDuplicate(
		existingFile: TFile,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch> {
		devLog(`Analyzing duplicate content: ${existingFile.path}`);
		const existingContent = await this.vault.read(existingFile);
		const fileCache = this.app.metadataCache.getFileCache(existingFile);

		// Get body content after frontmatter using Obsidian's metadata
		const existingBody = fileCache?.frontmatterPosition
			? existingContent.slice(fileCache.frontmatterPosition.end.offset)
			: existingContent;

		const existingHighlights = extractHighlights(existingBody);

		let newHighlightCount = 0;
		let modifiedHighlightCount = 0;

		const newHighlightsSet = new Set(
			newAnnotations.map((h) => this.getHighlightKey(h)),
		);
		const existingHighlightsMap = new Map(
			existingHighlights.map((h) => [this.getHighlightKey(h), h]),
		);

		for (const newHighlight of newAnnotations) {
			const key = this.getHighlightKey(newHighlight);
			const existingMatch = existingHighlightsMap.get(key);

			if (!existingMatch) {
				newHighlightCount++;
			} else {
				// Check if text content differs significantly (case-insensitive, whitespace normalized)
				if (
					!this.isHighlightTextEqual(
						existingMatch.text || "",
						newHighlight.text || "",
					)
				) {
					modifiedHighlightCount++;
					devLog(
						`Modified highlight found (Page ${newHighlight.pageno}):\n  Old: "${existingMatch.text?.slice(
							0,
							50,
						)}..."\n  New: "${newHighlight.text?.slice(0, 50)}..."`,
					);
				}
				if (!this.isNoteTextEqual(existingMatch.note, newHighlight.note)) {
					if (
						!this.isHighlightTextEqual(
							existingMatch.text || "",
							newHighlight.text || "",
						)
					) {
						devLog(
							`Note also differs for modified highlight (Page ${newHighlight.pageno})`,
						);
					} else {
						// Text is same, but note differs - count as modified
						modifiedHighlightCount++;
						devLog(
							`Note differs for existing highlight (Page ${newHighlight.pageno}):\n  Old: "${existingMatch.note?.slice(
								0,
								50,
							)}..."\n  New: "${newHighlight.note?.slice(0, 50)}..."`,
						);
					}
				}
			}
		}

		const matchType = this.determineMatchType(
			newHighlightCount,
			modifiedHighlightCount,
		);
		devLog(
			`Analysis result for ${existingFile.path}: Type=${matchType}, New=${newHighlightCount}, Modified=${modifiedHighlightCount}`,
		);

		return {
			file: existingFile,
			matchType: matchType,
			newHighlights: newHighlightCount,
			modifiedHighlights: modifiedHighlightCount,
			luaMetadata: luaMetadata,
		};
	}

	private async executeChoice(
		file: TFile,
		choice: DuplicateChoice,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
		newContent: string,
	): Promise<"created" | "merged" | "skipped"> {
		switch (choice) {
			case "skip":
				return "skipped";

			case "replace":
				await this.app.vault.modify(file, newContent ?? "");
				return "merged";

			case "merge": {
				const existingContent = await this.app.vault.read(file);
				const existing = extractHighlights(existingContent);
				const merged = await this.mergeContents(
					file,
					existing,
					newAnnotations,
					luaMetadata,
				);
				await this.app.vault.modify(file, merged);
				return "merged";
			}

			case "keep-both": {
				const uniquePath = await generateUniqueFilePath(
					this.app.vault,
					path.dirname(file.path),
					path.basename(file.path),
				);
				await this.app.vault.create(uniquePath, newContent);
				return "created";
			}

			default:
				return "skipped";
		}
	}

	private generatePromptMessage(match: DuplicateMatch): string {
		const baseMsg = `Duplicate note found for "${match.luaMetadata.docProps.title}" by ${match.luaMetadata.docProps.authors}.`;
		const fileMsg = `Existing file: "${match.file.path}"`;
		let details = "";

		switch (match.matchType) {
			case "exact":
				details =
					"The imported content appears identical to the existing file.";
				break;
			case "updated":
				details = `The import contains ${match.newHighlights} new highlight(s)/note(s).`;
				break;
			case "divergent":
				details = `The import contains ${match.newHighlights} new highlight(s)/note(s) and ${match.modifiedHighlights} modified one(s).`;
				break;
		}

		return `${baseMsg}\n${fileMsg}\n\n${details}\n\nHow would you like to proceed?`;
	}

	private mergeAnnotationArrays(
		existing: Annotation[],
		incoming: Annotation[],
	): Annotation[] {
		const key = (a: Annotation) =>
			`${a.pageno}|${a.pos0}|${a.pos1}|${(a.text || "").trim()}`;

		const seen = new Set(existing.map(key));
		const out = [...existing];

		for (const ann of incoming) {
			if (!seen.has(key(ann))) {
				out.push(ann);
				seen.add(key(ann));
			}
		}
		return out.sort(compareAnnotations);
	}

	/** Merges two frontmatter objects. Prioritizes existing values generally, updates specific fields. */
	private async mergeContents(
		file: TFile,
		existingAnnotations: Annotation[],
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<string> {
		const combined = this.mergeAnnotationArrays(
			existingAnnotations,
			newAnnotations,
		);

		const newBody = await this.contentGenerator.generateHighlightsContent(
			combined,
			luaMetadata,
		);

		const raw = await this.app.vault.read(file);

		if (!newBody.trim()) {
			devWarn(
				`mergeContents(): no highlights left for ${file.path}. Keeping the old body.`,
			);
			return raw; // write the original content back
		}

		let front = "";
		if (raw.startsWith("---")) {
			const end = raw.indexOf("\n---", 3);
			if (end !== -1) front = raw.slice(0, end + 4).trim();
		}
		return [front, newBody].filter(Boolean).join("\n\n");
	}

	private isMetadataMatch(
		existingFrontmatter: ParsedFrontmatter | null | undefined,
		newDocProps: DocProps,
	): boolean {
		if (!existingFrontmatter || !newDocProps) {
			return false;
		}

		const getFmValue = (keys: string[]): string => {
			for (const key of keys) {
				const value = existingFrontmatter[key];
				if (value) {
					return Array.isArray(value) ? value.join(", ") : String(value);
				}
			}

			const lowerKeys = keys.map((k) => k.toLowerCase());
			for (const fmKey in existingFrontmatter) {
				if (lowerKeys.includes(fmKey.toLowerCase())) {
					const value = existingFrontmatter[fmKey];
					return Array.isArray(value) ? value.join(", ") : String(value);
				}
			}
			return "";
		};

		const existingTitleRaw = getFmValue(["title", "Title"]);
		const existingAuthorsRaw = getFmValue([
			"authors",
			"author",
			"Author(s)",
			"Author",
		]).replace(/\[\[(.*?)\]\]/g, "$1"); // Strip Obsidian links

		const existingTitleNorm =
			DuplicateHandler.normalizeNamePart(existingTitleRaw);
		const existingAuthorsNorm =
			DuplicateHandler.normalizeNamePart(existingAuthorsRaw);
		const newTitleNorm = DuplicateHandler.normalizeNamePart(newDocProps.title);
		const newAuthorsNorm = DuplicateHandler.normalizeNamePart(
			newDocProps.authors,
		);

		// Require both title and author to match
		const titleMatch =
			existingTitleNorm.length > 0 && existingTitleNorm === newTitleNorm;
		const authorMatch =
			existingAuthorsNorm.length > 0 && existingAuthorsNorm === newAuthorsNorm;

		return titleMatch && authorMatch;
	}

	/** Normalizes text for comparison (trim, collapse whitespace, lowercase). */
	private normalizeForComparison(text?: string): string {
		return text?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
	}

	/** Checks if two highlight text blocks are functionally equal (ignore whitespace/case). */
	private isHighlightTextEqual(text1: string, text2: string): boolean {
		return (
			this.normalizeForComparison(text1) === this.normalizeForComparison(text2)
		);
	}

	/** Checks if two notes are functionally equal (ignore whitespace/case). */
	private isNoteTextEqual(note1?: string, note2?: string): boolean {
		return (
			this.normalizeForComparison(note1) === this.normalizeForComparison(note2)
		);
	}

	/** Creates a consistent key for caching potential duplicates. */

	private getCacheKey(docProps: DocProps): CacheKey {
		return DuplicateHandler.buildCacheKeyFromDocProps(docProps);
	}

	private determineMatchType(
		newCount: number,
		modifiedCount: number,
	): DuplicateMatch["matchType"] {
		if (newCount === 0 && modifiedCount === 0) return "exact";
		if (modifiedCount > 0) return "divergent";
		if (newCount > 0) return "updated"; // Only new highlights added
		return "exact";
	}

	private getHighlightKey(annotation: Annotation): string {
		// Use page number and starting position (if available) for uniqueness
		const posStart = annotation.pos0 || ""; // Fallback to empty string if undefined
		return `p${annotation.pageno}-${posStart}`;
	}

	private async buildGlobalVaultIndex(): Promise<void> {
		if (!this.settings.enableFullDuplicateCheck) return;

		this.globalVaultIndex.clear();
		this.fileToKey.clear();

		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			this.indexFile(file); // reuse incremental helper
		}
		this.isGlobalIndexBuilt = true;
		devLog(`Global vault index built with ${this.fileToKey.size} files.`);
	}

	private indexFile(file: TFile): void {
		const metadata = this.app.metadataCache.getFileCache(file);
		const fm = metadata?.frontmatter;
		if (!fm?.title) return;

		const authorsRaw = fm.authors ?? fm.author;
		if (!authorsRaw) return;

		const docProps: DocProps = {
			title: String(fm.title),
			authors: Array.isArray(authorsRaw)
				? authorsRaw.join(", ")
				: String(authorsRaw),
		};
		docProps.authors = docProps.authors.replace(/\[\[(.*?)\]\]/g, "$1");
		const newKey = this.getCacheKey(docProps);
		const oldKey = this.fileToKey.get(file.path);

		// Nothing changed
		if (oldKey === newKey) return;

		// 1. Remove from previous bucket
		if (oldKey && this.globalVaultIndex.has(oldKey)) {
			this.globalVaultIndex.get(oldKey)!.delete(file);
			if (this.globalVaultIndex.get(oldKey)!.size === 0) {
				this.globalVaultIndex.delete(oldKey);
			}
		}

		// 2. Add to new bucket
		if (!this.globalVaultIndex.has(newKey)) {
			this.globalVaultIndex.set(newKey, new Set());
		}
		this.globalVaultIndex.get(newKey)!.add(file);
		this.fileToKey.set(file.path, newKey);
	}

	/** Remove file entirely from the global index. */
	private unindexFile(filePath: string): void {
		const key = this.fileToKey.get(filePath);
		if (!key) return;
		const bucket = this.globalVaultIndex.get(key);
		if (bucket) {
			bucket.forEach((f) => {
				if (f.path === filePath) bucket.delete(f);
			});
			if (bucket.size === 0) this.globalVaultIndex.delete(key);
		}
		this.fileToKey.delete(filePath);
	}
}
