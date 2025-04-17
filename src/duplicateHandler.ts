import {
    type App,
    type CachedMetadata,
    type TAbstractFile,
    TFile,
    type Vault,
} from "obsidian";
import {
    extractFrontmatter,
    formatFrontmatter,
    type FrontmatterContent,
    type ParsedFrontmatter,
} from "./frontmatter";
import { extractHighlights, mergeHighlights } from "./highlightExtractor";
import type {
    Annotation,
    DocProps,
    DuplicateChoice,
    Frontmatter,
    IDuplicateHandlingModal,
    LuaMetadata,
} from "./types";
import {
    devError,
    devLog,
    generateFileName,
    generateUniqueFilePath,
} from "./utils";

export interface DuplicateMatch {
    file: TFile;
    matchType: "exact" | "updated" | "divergent";
    newHighlights: number;
    modifiedHighlights: number;
    luaMetadata: LuaMetadata;
}

type CacheKey = string;
type PotentialDuplicatesCache = Map<CacheKey, TFile[]>;

export class DuplicateHandler {
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
        private settings: {
            highlightsFolder: string;
            enableFullDuplicateCheck: boolean;
        },
    ) {
        // Register metadata cache events for cache invalidation
        this.app.metadataCache.on(
            "changed",
            (file, data, cache) => this.handleMetadataChange(file, data, cache),
        );
        this.app.metadataCache.on(
            "deleted",
            (file) => this.handleFileDeletion(file),
        );
        this.app.vault.on(
            "rename",
            (file: TFile | TAbstractFile, oldPath: string) => {
                if (file instanceof TFile) {
                    this.handleFileRename(file, oldPath);
                }
            },
        );
    }

    private handleMetadataChange(
        file: TFile,
        data: string,
        cache: CachedMetadata,
    ) {
        // Invalidate cache entries related to the modified file
        if (!file.path.startsWith(this.settings.highlightsFolder)) return;
        const { frontmatter } = cache;
        if (!frontmatter) return;
        const docProps: DocProps = {
            title: frontmatter.title,
            authors: frontmatter.authors,
            description: frontmatter.description,
            keywords: frontmatter.keywords,
            series: frontmatter.series,
            language: frontmatter.language,
        };

        if (!docProps.title || !docProps.authors) return;

        const cacheKey = this.getCacheKey(docProps);
        this.potentialDuplicatesCache.delete(cacheKey);
    }
    private handleFileDeletion(file: TFile) {
        // Remove cache entries related to the deleted file
        for (const [key, files] of this.potentialDuplicatesCache.entries()) {
            if (files.includes(file)) {
                this.potentialDuplicatesCache.delete(key);
            }
        }
    }

    private handleFileRename(file: TFile, oldPath: string) {
        // Invalidate cache entries related to the old and new paths
        for (const [key, files] of this.potentialDuplicatesCache.entries()) {
            if (
                files.some(
                    (f) => f.path === oldPath || f.path === file.path,
                )
            ) {
                this.potentialDuplicatesCache.delete(key);
            }
        }
    }

    async handleDuplicate(
        match: DuplicateMatch,
        newContent: string,
    ): Promise<{ choice: DuplicateChoice; applyToAll: boolean }> {
        try {
            this.currentMatch = match;

            // Reset state if not applying to all
            if (!this.applyToAll) {
                this.applyToAllChoice = null;
            }

            // If applyToAll is true, use the previously chosen action
            if (this.applyToAll && this.applyToAllChoice) {
                await this.handleChoice(
                    this.applyToAllChoice,
                    match,
                    newContent,
                );
                return { choice: this.applyToAllChoice, applyToAll: true };
            }

            // Otherwise, prompt the user for a choice
            const promptMessage = this.generatePromptMessage(match);
            const { choice, applyToAll } = await this.promptUser(promptMessage);

            // Update the apply-to-all state
            if (applyToAll) {
                this.applyToAll = true;
                this.applyToAllChoice = choice;
            }

            await this.handleChoice(choice, match, newContent);
            return { choice, applyToAll };
        } catch (error) {
            devError("Error handling duplicate:", error);
            return { choice: "skip", applyToAll: false };
        }
    }
    private async handleChoice(
        choice: DuplicateChoice,
        match: DuplicateMatch,
        newContent: string,
    ): Promise<void> {
        switch (choice) {
            case "replace":
                await this.vault.modify(match.file, newContent);
                break;
            case "merge": {
                const mergedContent = await this.mergeContents(
                    match.file,
                    newContent,
                );
                await this.vault.modify(match.file, mergedContent);
                break;
            }
            case "keep-both": {
                // this check is just to make the typescript linter happy
                // handleChoice wouldn't be called without a currentMatch
                if (!this.currentMatch) return;
                const newFileName = await this.generateUniqueFileName(
                    this.currentMatch.luaMetadata.docProps,
                );
                await this.vault.create(newFileName, newContent);
                break;
            }
            case "skip":
                break;
            default:
                throw new Error(`Invalid choice: ${choice}`);
        }
    }

    async findPotentialDuplicates(docProps: DocProps): Promise<TFile[]> {
        const cacheKey = this.getCacheKey(docProps);
        if (this.potentialDuplicatesCache.has(cacheKey)) {
            devLog(`Cache hit for ${cacheKey}`);
            const cachedResult = this.potentialDuplicatesCache.get(cacheKey);
            if (cachedResult) {
                return cachedResult;
            }
        }

        const files = this.settings.enableFullDuplicateCheck
            ? this.vault.getMarkdownFiles()
            : this.vault.getFiles().filter((file) =>
                file.path.startsWith(this.settings.highlightsFolder)
            );
        const potentialDuplicates: TFile[] = [];

        for (const file of files) {
            const content = await this.vault.read(file);
            const frontmatter = extractFrontmatter(content);

            if (this.isMetadataMatch(file, frontmatter, docProps)) {
                potentialDuplicates.push(file);
            }
        }

        this.potentialDuplicatesCache.set(cacheKey, potentialDuplicates);
        return potentialDuplicates;
    }
    private getCacheKey(docProps: DocProps): CacheKey {
        return `${docProps.authors}-${docProps.title}`;
    }

    private isMetadataMatch(
        file: TFile,
        frontmatter: ParsedFrontmatter,
        docProps: DocProps,
    ): boolean {
        const metadata = this.app.metadataCache.getFileCache(file);
        if (!metadata?.frontmatter) return false;

        // Handle different frontmatter author formats
        const frontmatterAuthors = typeof frontmatter.authors === "string"
            ? frontmatter.authors.replace(/\[\[(.*?)\]\]/, "$1")
            : Array.isArray(frontmatter.authors)
            ? frontmatter.authors.join(", ")
            : String(frontmatter.authors || "");

        const authorMatch = frontmatterAuthors === docProps.authors;
        const titleMatch = frontmatter.title === docProps.title;

        return authorMatch && titleMatch;
    }

    async analyzeDuplicate(
        existingFile: TFile,
        newHighlights: Annotation[],
        luaMetadata: LuaMetadata,
    ): Promise<DuplicateMatch> {
        const existingContent = await this.vault.read(existingFile);
        const existingHighlights = this.extractHighlights(existingContent);

        let newHighlightCount = 0;
        let modifiedHighlightCount = 0;

        for (const newHighlight of newHighlights) {
            const existingMatch = existingHighlights.find((eh) =>
                eh.chapter === newHighlight.chapter &&
                eh.pageno === newHighlight.pageno
            );

            if (!existingMatch) {
                newHighlightCount++;
            } else if (
                !this.isHighlightTextEqual(
                    existingMatch.text || "",
                    newHighlight.text || "",
                )
            ) {
                modifiedHighlightCount++;
            }
        }

        return {
            file: existingFile,
            matchType: this.determineMatchType(
                newHighlightCount,
                modifiedHighlightCount,
            ),
            newHighlights: newHighlightCount,
            modifiedHighlights: modifiedHighlightCount,
            luaMetadata,
        };
    }

    private extractHighlights(content: string): Annotation[] {
        return extractHighlights(content);
    }

    private isHighlightTextEqual(text1: string, text2: string): boolean {
        const normalize = (text: string) =>
            text.trim().replace(/\s+/g, " ").toLowerCase();
        return normalize(text1) === normalize(text2);
    }

    private determineMatchType(
        newCount: number,
        modifiedCount: number,
    ): "exact" | "updated" | "divergent" {
        if (newCount === 0 && modifiedCount === 0) return "exact";
        if (modifiedCount > 0) return "divergent";
        return "updated";
    }

    private generatePromptMessage(match: DuplicateMatch): string {
        const baseMsg =
            `Found a ${match.matchType} match in "${match.file.path}":\n`;
        const details = match.matchType === "exact"
            ? "Content appears to be identical."
            : `${match.newHighlights} new highlights, ${match.modifiedHighlights} modified highlights.`;

        return `${baseMsg}${details}\n\nHow would you like to proceed?`;
    }

    async promptUser(
        message: string,
    ): Promise<{
        choice: DuplicateChoice;
        applyToAll: boolean;
    }> {
        // this check is just to make the typescript linter happy
        // promptUser wouldn't be called without a currentMatch
        if (!this.currentMatch) {
            console.error("No current match set. Skipping duplicate handling.");
            return { choice: "skip", applyToAll: false };
        }

        const modal = this.modalFactory(this.app, this.currentMatch, message);
        return await modal.openAndGetChoice();
    }

    private async mergeContents(
        existingFile: TFile,
        newContent: string,
    ): Promise<string> {
        const existingContent = await this.vault.read(existingFile);
        const existingHighlights = await this.extractHighlightsFromFile(
            existingFile,
        );
        const newHighlights = this.extractHighlights(newContent);

        const mergedHighlights: Annotation[] = this.mergeHighlights(
            existingHighlights,
            newHighlights,
        );

        const { frontmatter: existingFrontmatter } = this
            .parseFrontmatterAndContent(existingContent);
        const { frontmatter: newFrontmatter } = this.parseFrontmatterAndContent(
            newContent,
        );

        return this.formatMergedContent(
            existingFrontmatter,
            newFrontmatter,
            mergedHighlights,
        );
    }

    private parseFrontmatterAndContent(content: string): FrontmatterContent {
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n\n/);
        if (!frontmatterMatch) {
            return {
                content: content,
                frontmatter: {},
            };
        }

        const frontmatterYaml = frontmatterMatch[1];
        const frontmatter: ParsedFrontmatter = {};

        // Parse the YAML frontmatter
        const lines = frontmatterYaml.split("\n");
        for (const line of lines) {
            const [key, ...valueParts] = line.split(":");
            if (key && valueParts.length) {
                const value = valueParts.join(":").trim().replace(
                    /^"(.*)"$/,
                    "$1",
                );
                frontmatter[key.trim()] = value;
            }
        }

        return {
            content: content.slice(frontmatterMatch[0].length),
            frontmatter,
        };
    }

    private formatMergedContent(
        existingFrontmatter: ParsedFrontmatter,
        newFrontmatter: ParsedFrontmatter,
        mergedHighlights: Annotation[],
    ): string {
        // Merge frontmatter, preferring existing user modifications
        const mergedFrontmatter = this.mergeFrontmatter(
            existingFrontmatter,
            newFrontmatter,
        );
        const frontmatterString = this.formatFrontmatter(mergedFrontmatter);
        const highlightsContent = this.formatHighlights(mergedHighlights);

        return `---\n${frontmatterString}---\n\n${highlightsContent}`;
    }

    private mergeFrontmatter(
        existing: Partial<Frontmatter>,
        newer: Partial<Frontmatter>,
    ): Frontmatter {
        // Start by copying all properties from the existing object.
        const merged: Partial<Frontmatter> = { ...existing };

        // Iterate over keys in the newer object.
        for (const key in newer) {
            if (!Object.prototype.hasOwnProperty.call(newer, key)) continue;

            const newValue = newer[key];
            const existingValue = merged[key];

            // If no existing value exists, simply take the new value.
            if (existingValue === undefined) {
                merged[key] = newValue;
                continue;
            }

            // If both are arrays then merge them uniquely.
            if (Array.isArray(existingValue) && Array.isArray(newValue)) {
                merged[key] = Array.from(
                    new Set([...existingValue, ...newValue]),
                );
                continue;
            }

            // For specific fields that relate to dates or statistics, take the new value.
            if (["lastRead", "firstRead", "totalReadTime"].includes(key)) {
                merged[key] = newValue;
                continue;
            }

            // For the description field, choose the longer string (if both are strings).
            if (
                key === "description" &&
                typeof newValue === "string" &&
                typeof existingValue === "string"
            ) {
                merged[key] = newValue.length > existingValue.length
                    ? newValue
                    : existingValue;
                continue;
            }

            // Otherwise, prefer the existing value.
            merged[key] = existingValue;
        }

        // Ensure required properties are set (default to empty strings if necessary)
        merged.title = merged.title ?? "";
        merged.authors = merged.authors ?? "";

        return merged as Frontmatter;
    }

    private formatFrontmatter(frontmatter: ParsedFrontmatter): string {
        // Use the unified function with options for raw formatting
        return formatFrontmatter(frontmatter, {
            useFriendlyKeys: false,
            sortKeys: false,
            escapeStrings: false,
        }).replace(/^---\n|---\n$/g, ""); // Remove YAML markers if needed
    }

    private async extractHighlightsFromFile(
        file: TFile,
    ): Promise<Annotation[]> {
        const content = await this.vault.read(file);
        return this.extractHighlights(content);
    }

    private formatHighlights(highlights: Annotation[]): string {
        return highlights
            .map((h) =>
                `### Chapter: ${h.chapter}\n(*Date: ${h.datetime} - Page: ${h.pageno}*)\n\n${h.text}\n\n---\n`
            )
            .join("");
    }

    private async generateUniqueFileName(docProps: DocProps): Promise<string> {
        const fileName = generateFileName(
            docProps,
            this.settings.highlightsFolder,
        );
        return generateUniqueFilePath(
            this.vault,
            this.settings.highlightsFolder,
            fileName,
        );
    }

    normalizeFileName(fileName: string): string {
        return fileName.replace(/[\\/:*?"<>|]/g, "_").trim();
    }

    private mergeHighlights(
        existing: Annotation[],
        newHighlights: Annotation[],
    ): Annotation[] {
        return mergeHighlights(
            existing,
            newHighlights,
            (a, b) => this.isHighlightTextEqual(a, b),
        );
    }
}
