import {
    type App,
    type CachedMetadata,
    Notice,
    type TAbstractFile,
    TFile,
    type Vault,
} from "obsidian";
import {
    type ParsedFrontmatter,
    parseFrontmatterAndContent,
} from "../frontmatter";
import { extractHighlights, mergeHighlights } from "../highlightExtractor";
import type {
    Annotation,
    DocProps,
    DuplicateChoice,
    DuplicateMatch,
    IDuplicateHandlingModal,
    KoReaderHighlightImporterSettings,
    LuaMetadata,
} from "../types";
import { generateUniqueFilePath } from "../utils/fileUtils";
import {
    formatDate,
    generateObsidianFileName,
    normalizeFileNamePiece,
} from "../utils/formatUtils";
import { devError, devLog, devWarn } from "../utils/logging";
import { FrontmatterGenerator } from "./FrontmatterGenerator";

type CacheKey = string;
type PotentialDuplicatesCache = Map<CacheKey, TFile[]>;

export class DuplicateHandler {
    private frontmatterGenerator: FrontmatterGenerator;
    currentMatch: NonNullable<DuplicateMatch> | null = null;
    private applyToAll = false;
    private applyToAllChoice: DuplicateChoice | null = null;
    private potentialDuplicatesCache: PotentialDuplicatesCache = new Map();

    constructor(
        private vault: Vault,
        private app: App,
        private modalFactory: (
            app: App,
            match: DuplicateMatch,
            message: string,
        ) => IDuplicateHandlingModal,
        private settings: KoReaderHighlightImporterSettings,
        frontmatterGeneratorInstance: FrontmatterGenerator,
    ) {
        this.registerMetadataCacheEvents();
        this.frontmatterGenerator = frontmatterGeneratorInstance;
    }

    private registerMetadataCacheEvents(): void {
        this.app.metadataCache.on(
            "changed",
            this.handleMetadataChange.bind(this),
        );
        this.app.metadataCache.on(
            "deleted",
            this.handleFileDeletion.bind(this),
        );
        this.app.vault.on("rename", this.handleFileRename.bind(this));
        devLog("DuplicateHandler: Registered metadata cache listeners.");
    }

    // --- Cache Invalidation Handlers ---

    private handleMetadataChange(
        file: TFile,
        _data: string,
        cache: CachedMetadata,
    ): void {
        // Only invalidate if the change is within the highlights folder (or if checking full vault)
        if (
            !this.settings.enableFullDuplicateCheck &&
            !file.path.startsWith(this.settings.highlightsFolder)
        ) {
            return;
        }

        const frontmatter = cache.frontmatter;
        // Invalidate cache based on Title/Author from the *changed* file's metadata
        if (frontmatter?.title && frontmatter?.authors) {
            // Reconstruct DocProps from potentially varied frontmatter formats
            const docProps: DocProps = {
                title: String(frontmatter.title),
                authors: Array.isArray(frontmatter.authors)
                    ? frontmatter.authors.join(", ")
                    : String(frontmatter.authors || ""),
            };
            docProps.authors = docProps.authors.replace(/\[\[(.*?)\]\]/g, "$1");

            const cacheKey = this.getCacheKey(docProps);
            if (this.potentialDuplicatesCache.has(cacheKey)) {
                this.potentialDuplicatesCache.delete(cacheKey);
                devLog(
                    `Invalidated duplicate cache for key (metadata change): ${cacheKey}`,
                );
            }
        } else {
            devLog(
                `Cannot invalidate specific cache key for ${file.path} due to missing title/author in frontmatter after change.`,
            );
        }
    }

    private handleFileDeletion(file: TFile): void {
        // Remove the deleted file from any cache entry it might be part of
        let invalidated = false;
        for (const [key, files] of this.potentialDuplicatesCache.entries()) {
            const index = files.findIndex((f) => f.path === file.path);
            if (index !== -1) {
                files.splice(index, 1);
                devLog(
                    `Removed deleted file ${file.path} from duplicate cache key: ${key}`,
                );
                invalidated = true;
            }
        }
        if (!invalidated) {
            // devLog(`Deleted file ${file.path} not found in duplicate cache.`);
        }
    }

    private handleFileRename(file: TAbstractFile, oldPath: string): void {
        if (!(file instanceof TFile)) return; // Only handle file renames

        // Treat rename as a deletion of the old path and potentially an addition of the new path.
        // We need to invalidate caches related to *both* old and new paths/metadata.

        // Invalidate based on old path (remove it from lists)
        let invalidatedOld = false;
        for (const [key, files] of this.potentialDuplicatesCache.entries()) {
            const index = files.findIndex((f) => f.path === oldPath);
            if (index !== -1) {
                files.splice(index, 1);
                devLog(
                    `Removed renamed file (old path ${oldPath}) from duplicate cache key: ${key}`,
                );
                invalidatedOld = true;
            }
        }

        // Invalidate cache based on the *new* metadata of the renamed file
        // Need to wait briefly for metadata cache to potentially update after rename
        // Using setTimeout is a common workaround in Obsidian plugins for this
        setTimeout(async () => {
            try {
                const newCache = this.app.metadataCache.getFileCache(file);
                if (newCache) {
                    this.handleMetadataChange(file, "", newCache); // Simulate metadata change
                } else {
                    devWarn(
                        `Could not get metadata cache for renamed file: ${file.path}`,
                    );
                }
            } catch (error) {
                devError(
                    `Error handling metadata cache after rename for ${file.path}:`,
                    error,
                );
            }
        }, 500); // Adjust delay if needed
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
        match: DuplicateMatch,
        newContent: string,
    ): Promise<{ choice: DuplicateChoice; applyToAll: boolean }> {
        this.currentMatch = match; // Store current match for modal context

        if (this.applyToAll && this.applyToAllChoice) {
            devLog(
                `Applying stored choice "${this.applyToAllChoice}" to duplicate: ${match.file.path}`,
            );
            await this.executeChoice(this.applyToAllChoice, match, newContent);
            return { choice: this.applyToAllChoice, applyToAll: true };
        }

        this.applyToAll = false;
        this.applyToAllChoice = null;

        // Prompt the user
        const promptMessage = this.generatePromptMessage(match);
        const modal = this.modalFactory(this.app, match, promptMessage);
        const { choice, applyToAll: userChoseApplyToAll } = await modal
            .openAndGetChoice();

        devLog(
            `User chose "${choice}" for duplicate: ${match.file.path}. Apply to all: ${userChoseApplyToAll}`,
        );

        // Update apply-to-all state for subsequent calls *within this import run*
        if (userChoseApplyToAll) {
            this.applyToAll = true;
            this.applyToAllChoice = choice;
        }

        await this.executeChoice(choice, match, newContent);

        return { choice, applyToAll: userChoseApplyToAll };
    }

    async findPotentialDuplicates(docProps: DocProps): Promise<TFile[]> {
        const cacheKey = this.getCacheKey(docProps);
        if (this.potentialDuplicatesCache.has(cacheKey)) {
            devLog(`Cache hit for potential duplicates: ${cacheKey}`);
            return [...(this.potentialDuplicatesCache.get(cacheKey) || [])];
        }

        devLog(
            `Cache miss for potential duplicates: ${cacheKey}. Searching vault...`,
        );

        const filesToCheck: TFile[] = this.settings.enableFullDuplicateCheck
            ? this.app.vault.getMarkdownFiles()
            : this.app.vault.getFiles().filter(
                (file): file is TFile =>
                    file instanceof TFile &&
                    file.path.startsWith(
                        `${this.settings.highlightsFolder}/`,
                    ) &&
                    file.extension === "md",
            );

        devLog(
            `Checking ${filesToCheck.length} files for duplicates (Full vault check: ${this.settings.enableFullDuplicateCheck})`,
        );

        const potentialDuplicates: TFile[] = [];
        for (const file of filesToCheck) {
            const metadata = this.app.metadataCache.getFileCache(file);
            if (this.isMetadataMatch(metadata?.frontmatter, docProps)) {
                potentialDuplicates.push(file);
                devLog(`Potential duplicate found: ${file.path}`);
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
        const { content: existingBody } = parseFrontmatterAndContent(
            existingContent,
        );
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
                        `Modified highlight found (Page ${newHighlight.pageno}):\n  Old: "${
                            existingMatch.text?.slice(0, 50)
                        }..."\n  New: "${newHighlight.text?.slice(0, 50)}..."`,
                    );
                }
                if (
                    !this.isNoteTextEqual(existingMatch.note, newHighlight.note)
                ) {
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
                            `Note differs for existing highlight (Page ${newHighlight.pageno}):\n  Old: "${
                                existingMatch.note?.slice(0, 50)
                            }..."\n  New: "${
                                newHighlight.note?.slice(0, 50)
                            }..."`,
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
        choice: DuplicateChoice,
        match: DuplicateMatch,
        newContent: string,
    ): Promise<void> {
        try {
            switch (choice) {
                case "replace":
                    devLog(`Replacing file: ${match.file.path}`);
                    await this.vault.modify(match.file, newContent);
                    break;
                case "merge": {
                    if (match.matchType === "exact") {
                        devLog("Merge skipped for exact match.");
                        break;
                    }
                    devLog(`Merging content into file: ${match.file.path}`);
                    const mergedContent = await this.mergeContents(
                        match.file,
                        newContent,
                    );
                    await this.vault.modify(match.file, mergedContent);
                    break;
                }
                case "keep-both": {
                    devLog("Keeping both. Creating new file for import...");

                    let originalSdrNameForFallback: string | undefined =
                        undefined;
                    if (match.luaMetadata.originalFilePath) {
                        originalSdrNameForFallback = match.luaMetadata
                            .originalFilePath.split(/[/\\]/).pop();
                    } else {
                        devWarn(
                            "Original SDR name not available for 'keep-both' filename generation in DuplicateHandler. Filename might be less specific if metadata is missing.",
                        );
                    }

                    const originalDesiredName = generateObsidianFileName(
                        match.luaMetadata.docProps,
                        this.settings.highlightsFolder,
                        originalSdrNameForFallback,
                    );

                    const uniqueFilePath = await generateUniqueFilePath(
                        this.vault,
                        this.settings.highlightsFolder,
                        originalDesiredName,
                    );
                    devLog(`Creating unique file at: ${uniqueFilePath}`);
                    await this.vault.create(uniqueFilePath, newContent);
                    break;
                }
                case "skip":
                    devLog(`Skipping duplicate action for: ${match.file.path}`);
                    break;
                default:
                    devWarn(`Invalid duplicate choice received: ${choice}`);
            }
        } catch (error) {
            devError(
                `Error executing duplicate choice "${choice}" for ${match.file.path}:`,
                error,
            );
            new Notice(
                `Failed to ${choice} file: ${match.file.path}. Check console.`,
            );
        }
    }

    private generatePromptMessage(match: DuplicateMatch): string {
        const baseMsg =
            `Duplicate note found for "${match.luaMetadata.docProps.title}" by ${match.luaMetadata.docProps.authors}.`;
        const fileMsg = `Existing file: "${match.file.path}"`;
        let details = "";

        switch (match.matchType) {
            case "exact":
                details =
                    "The imported content appears identical to the existing file.";
                break;
            case "updated":
                details =
                    `The import contains ${match.newHighlights} new highlight(s)/note(s).`;
                break;
            case "divergent":
                details =
                    `The import contains ${match.newHighlights} new highlight(s)/note(s) and ${match.modifiedHighlights} modified one(s).`;
                break;
        }

        return `${baseMsg}\n${fileMsg}\n\n${details}\n\nHow would you like to proceed?`;
    }

    private async mergeContents(
        existingFile: TFile,
        newContentString: string,
    ): Promise<string> {
        devLog(`Starting content merge for: ${existingFile.path}`);
        const existingContent = await this.vault.read(existingFile);

        const { frontmatter: existingFrontmatter, content: existingBody } =
            parseFrontmatterAndContent(existingContent);
        const { frontmatter: newFrontmatterData, content: newBody } =
            parseFrontmatterAndContent(newContentString);

        const existingHighlights = extractHighlights(existingBody);
        const newHighlights = extractHighlights(newBody);

        devLog(
            `Existing highlights: ${existingHighlights.length}, New highlights: ${newHighlights.length}`,
        );

        const mergedAnnotationList: Annotation[] = mergeHighlights(
            existingHighlights,
            newHighlights,
            this.isHighlightTextEqual, // comparison function
        );
        devLog(`Total highlights after merge: ${mergedAnnotationList.length}`);

        const mergedFrontmatter = this.mergeFrontmatterData(
            existingFrontmatter,
            newFrontmatterData,
        );

        const mergedBodyContent = this.formatMergedBodySimple(
            mergedAnnotationList,
        );
        devLog("Generated merged body content.");

        const finalFrontmatterString = this.frontmatterGenerator
            .formatDataToYaml(
                mergedFrontmatter,
                {
                    useFriendlyKeys: true,
                    sortKeys: true,
                },
            );

        const fullMergedContent =
            (finalFrontmatterString
                ? `---\n${
                    finalFrontmatterString.replace(/^---\n|---\n$/g, "")
                }\n---\n\n`
                : "") + mergedBodyContent;

        return fullMergedContent;
    }

    private formatMergedBodySimple(highlights: Annotation[]): string {
        if (!highlights || highlights.length === 0) return "";

        const sorted = [...highlights].sort((a, b) => {
            if (a.pageno !== b.pageno) return a.pageno - b.pageno;
            return 0;
        });

        const groupedByChapter = sorted.reduce((acc, h) => {
            const chapter = h.chapter || "Unknown Chapter";
            if (!acc[chapter]) acc[chapter] = [];
            acc[chapter].push(h);
            return acc;
        }, {} as Record<string, Annotation[]>);

        let body = "";
        let firstBlockOverall = true;

        for (const chapter in groupedByChapter) {
            if (body.length > 0 && !body.endsWith("\n\n")) { // Ensure enough space before a new chapter heading
                body += "\n\n";
            } else if (body.length > 0 && !body.endsWith("\n")) {
                body += "\n";
            }

            if (chapter !== "Unknown Chapter") {
                body += `## ${chapter}\n\n`;
            }
            for (const h of groupedByChapter[chapter]) {
                let blockParts: string[] = []; // Collect parts of the block

                blockParts.push(
                    `*Page ${h.pageno} | ${formatDate(h.datetime)}*`,
                );

                let styledText = h.text || "";
                if (h.color && h.color !== "gray") {
                    styledText = `<mark>${styledText}</mark>`;
                }
                if (styledText.trim()) {
                    blockParts.push(styledText.trim());
                }

                if (h.note) {
                    blockParts.push(
                        `> [!NOTE] Note\n> ${
                            h.note.replace(/\n/g, "\n> ").trim()
                        }`,
                    );
                }

                const currentBlockContent = blockParts.join("\n") + "\n"; // Each block ends with one newline

                if (!firstBlockOverall) {
                    body += "\n\n---\n"; // Separator: blank line, ---, one newline
                }
                body += currentBlockContent;

                firstBlockOverall = false;
            }
        }
        return body.trim();
    }

    /** Merges two frontmatter objects. Prioritizes existing values generally, updates specific fields. */
    private mergeFrontmatterData(
        existing: ParsedFrontmatter,
        newDataFromImport: ParsedFrontmatter,
    ): ParsedFrontmatter {
        const merged: ParsedFrontmatter = { ...existing };

        for (const key in newDataFromImport) {
            if (!Object.prototype.hasOwnProperty.call(newDataFromImport, key)) {
                continue;
            }

            const newValue = newDataFromImport[key];
            const existingValue = merged[key];

            // Prioritize new values for stats-related fields from the import
            if (
                key === "lastRead" || key === "progress" ||
                key === "readingStatus" ||
                key === "totalReadTime" || key === "averageTimePerPage" ||
                key === "highlightCount" || key === "noteCount" ||
                key === "pages" ||
                key === "firstRead"
            ) {
                merged[key] = newValue;
            } // For tags/keywords, merge them
            else if (
                (key === "keywords" || key === "tags") &&
                (Array.isArray(existingValue) || Array.isArray(newValue))
            ) {
                const existingArray = Array.isArray(existingValue)
                    ? existingValue
                    : (existingValue
                        ? String(existingValue).split(",").map((s) => s.trim())
                        : []);
                const newArray = Array.isArray(newValue)
                    ? newValue
                    : (newValue
                        ? String(newValue).split(",").map((s) => s.trim())
                        : []);
                merged[key] = Array.from(
                    new Set([...existingArray, ...newArray]),
                ).filter(Boolean);
            } // If existing value is missing, or new value is "more complete" (e.g. description)
            else if (
                existingValue === undefined || existingValue === null ||
                existingValue === ""
            ) {
                merged[key] = newValue;
            } else if (
                key === "description" && typeof newValue === "string" &&
                typeof existingValue === "string" &&
                newValue.length > existingValue.length
            ) {
                merged[key] = newValue; // Keep longer description
            }
            // Default: keep existing for other fields (e.g. title, authors, user-added custom fields in existing note)
            // unless explicitly overwritten by a more specific rule above.
        }
        devLog("Merged frontmatter object completed.");
        return merged;
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
                    return Array.isArray(value)
                        ? value.join(", ")
                        : String(value);
                }
            }

            const lowerKeys = keys.map((k) => k.toLowerCase());
            for (const fmKey in existingFrontmatter) {
                if (lowerKeys.includes(fmKey.toLowerCase())) {
                    const value = existingFrontmatter[fmKey];
                    return Array.isArray(value)
                        ? value.join(", ")
                        : String(value);
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
        ])
            .replace(/\[\[(.*?)\]\]/g, "$1"); // Strip Obsidian links

        const normalize = (str: string) =>
            normalizeFileNamePiece(str || "").toLowerCase();

        const existingTitleNorm = normalize(existingTitleRaw);
        const existingAuthorsNorm = normalize(existingAuthorsRaw);
        const newTitleNorm = normalize(newDocProps.title);
        const newAuthorsNorm = normalize(newDocProps.authors);

        // Require both title and author to match
        const titleMatch = existingTitleNorm.length > 0 &&
            existingTitleNorm === newTitleNorm;
        const authorMatch = existingAuthorsNorm.length > 0 &&
            existingAuthorsNorm === newAuthorsNorm;

        return titleMatch && authorMatch;
    }

    /** Checks if two highlight text blocks are functionally equal (ignore whitespace/case). */
    private isHighlightTextEqual(text1: string, text2: string): boolean {
        const normalize = (text: string) =>
            text?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
        return normalize(text1) === normalize(text2);
    }

    /** Checks if two notes are functionally equal (ignore whitespace/case). */
    private isNoteTextEqual(note1?: string, note2?: string): boolean {
        // Treat null/undefined/empty strings as equal
        const normalized1 = note1?.trim().replace(/\s+/g, " ").toLowerCase() ??
            "";
        const normalized2 = note2?.trim().replace(/\s+/g, " ").toLowerCase() ??
            "";
        return normalized1 === normalized2;
    }

    /** Creates a consistent key for caching potential duplicates. */
    private getCacheKey(docProps: DocProps): CacheKey {
        // Normalize author and title for consistent caching
        const authorKey = normalizeFileNamePiece(docProps.authors || "")
            .toLowerCase();
        const titleKey = normalizeFileNamePiece(docProps.title || "")
            .toLowerCase();
        return `${authorKey}::${titleKey}`;
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
}
