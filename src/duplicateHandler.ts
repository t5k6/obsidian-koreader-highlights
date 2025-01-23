import {
    type App,
    type CachedMetadata,
    type TAbstractFile,
    TFile,
    type Vault,
} from "obsidian";
import type {
    Annotation,
    DocProps,
    DuplicateChoice,
    Frontmatter,
    IDuplicateHandlingModal,
    LuaMetadata,
} from "./types";
import { devError, devLog, generateUniqueFilePath } from "./utils";

export interface DuplicateMatch {
    file: TFile;
    matchType: "exact" | "updated" | "divergent";
    newHighlights: number;
    modifiedHighlights: number;
    luaMetadata: LuaMetadata;
}

interface ParsedFrontmatter {
    authors?: string;
    title?: string;
    [key: string]: string | string[] | number | undefined;
}

interface FrontmatterContent {
    content: string;
    frontmatter: ParsedFrontmatter;
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
            const frontmatter = this.extractFrontmatter(content);

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

    private extractFrontmatter(content: string): ParsedFrontmatter {
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!frontmatterMatch) return {};

        const frontmatter: ParsedFrontmatter = {};
        const lines = frontmatterMatch[1].split("\n");

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

        return frontmatter;
    }

    private isMetadataMatch(
        file: TFile,
        frontmatter: ParsedFrontmatter,
        docProps: DocProps,
    ): boolean {
        const metadata = this.app.metadataCache.getFileCache(file);
        if (!metadata?.frontmatter) return false;
        const authorMatch =
            frontmatter.authors?.replace(/\[\[(.*?)\]\]/, "$1") ===
                docProps.authors;
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
                    existingMatch.text,
                    newHighlight.text,
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
        const highlights: Annotation[] = [];
        const lines = content.split("\n");

        let currentHighlight: Partial<Annotation> | null = null;
        let collectingText = false;
        let currentText: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Skip frontmatter
            if (i === 0 && line === "---") {
                while (i < lines.length && lines[i] !== "---") i++;
                continue;
            }

            // Check for chapter header
            const chapterMatch = line.match(/^### Chapter: (.+)$/);
            if (chapterMatch) {
                if (currentHighlight) {
                    this.finalizeHighlight(
                        currentHighlight,
                        currentText,
                        highlights,
                    );
                }
                currentHighlight = { chapter: chapterMatch[1] };
                currentText = [];
                continue;
            }

            // Check for metadata line (date and page)
            const metadataMatch = line.match(
                /^\(\*Date: (.+) - Page: (\d+)\*\)$/,
            );
            if (metadataMatch && currentHighlight) {
                currentHighlight.datetime = metadataMatch[1];
                currentHighlight.pageno = Number.parseInt(metadataMatch[2], 10);
                collectingText = true;
                continue;
            }

            // Check for highlight end
            if (line === "---") {
                if (currentHighlight) {
                    this.finalizeHighlight(
                        currentHighlight,
                        currentText,
                        highlights,
                    );
                }
                currentHighlight = null;
                collectingText = false;
                currentText = [];
                continue;
            }

            // Collect highlight text
            if (collectingText && currentHighlight) {
                if (line.trim()) {
                    currentText.push(line);
                }
            }
        }

        // Handle the last highlight if exists
        if (currentHighlight) {
            this.finalizeHighlight(currentHighlight, currentText, highlights);
        }

        return highlights;
    }

    private finalizeHighlight(
        highlight: Partial<Annotation>,
        textLines: string[],
        highlights: Annotation[],
    ): void {
        if (highlight.chapter && highlight.datetime && highlight.pageno) {
            highlights.push({
                chapter: highlight.chapter,
                datetime: highlight.datetime,
                pageno: highlight.pageno,
                text: textLines.join("\n").trim(),
            } as Annotation);
        }
    }

    /**
     * Alternative implementation using chunks for very large files.
     * This version is more memory efficient for huge files as it processes
     * the content in smaller chunks.
     */
    private extractHighlightsStreaming(content: string): Annotation[] {
        const CHUNK_SIZE = 8192; // 8KB chunks
        const highlights: Annotation[] = [];
        let buffer = "";
        let position = 0;

        while (position < content.length) {
            // Read next chunk
            const chunk = content.slice(position, position + CHUNK_SIZE);
            buffer += chunk;

            // Find complete highlight blocks in buffer
            const blockEnd = buffer.lastIndexOf("\n---\n");

            if (blockEnd !== -1) {
                // Process complete blocks
                const completeContent = buffer.slice(0, blockEnd);
                const remainingBuffer = buffer.slice(blockEnd + 4);

                // Extract highlights from complete content
                this.processHighlightBlocks(completeContent, highlights);

                // Keep remaining partial block in buffer
                buffer = remainingBuffer;
            }

            position += CHUNK_SIZE;
        }

        // Process any remaining content
        if (buffer.trim()) {
            this.processHighlightBlocks(buffer, highlights);
        }

        return highlights;
    }

    /**
     * Helper method to process highlight blocks for the streaming implementation
     */
    private processHighlightBlocks(
        content: string,
        highlights: Annotation[],
    ): void {
        const blocks = content.split("\n---\n");

        for (const block of blocks) {
            if (!block.trim()) continue;

            const lines = block.split("\n");
            const chapterMatch = lines[0]?.match(/^### Chapter: (.+)$/);
            const metadataMatch = lines[1]?.match(
                /^\(\*Date: (.+) - Page: (\d+)\*\)$/,
            );

            if (chapterMatch && metadataMatch) {
                highlights.push({
                    chapter: chapterMatch[1],
                    datetime: metadataMatch[1],
                    pageno: Number.parseInt(metadataMatch[2], 10),
                    text: lines.slice(2).join("\n").trim(),
                } as Annotation);
            }
        }
    }

    /**
     * Performance monitoring wrapper for highlight extraction
     */
    private extractHighlightsWithMetrics(content: string): {
        highlights: Annotation[];
        metrics: {
            duration: number;
            highlightCount: number;
            contentSize: number;
        };
    } {
        const startTime = performance.now();
        const highlights = content.length > 50000
            ? this.extractHighlightsStreaming(content)
            : this.extractHighlights(content);
        const endTime = performance.now();

        return {
            highlights,
            metrics: {
                duration: endTime - startTime,
                highlightCount: highlights.length,
                contentSize: content.length,
            },
        };
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
        existing: Frontmatter,
        newer: Frontmatter,
    ): Frontmatter {
        const merged = { ...existing };

        // List of fields that should always be updated from the new content
        const alwaysUpdateFields = ["title", "authors", "url", "lastAnnotated"];

        // Update fields that should always be refreshed
        for (const field of alwaysUpdateFields) {
            if (newer[field]) {
                merged[field] = newer[field];
            }
        }

        // Add any new fields that don't exist in the existing frontmatter
        for (const [key, value] of Object.entries(newer)) {
            if (
                !Object.hasOwn(merged, key) &&
                !alwaysUpdateFields.includes(key)
            ) {
                merged[key] = value;
            }
        }

        return merged;
    }

    private formatFrontmatter(frontmatter: ParsedFrontmatter): string {
        return Object.entries(frontmatter)
            .map(([key, value]) => {
                // Handle arrays
                if (Array.isArray(value)) {
                    return `${key}: [${value.join(", ")}]`;
                }
                // Handle strings that need quotes
                if (
                    typeof value === "string" &&
                    (value.includes(":") || value.includes("\n"))
                ) {
                    return `${key}: "${value.replace(/"/g, '\\"')}"`;
                }
                return `${key}: ${value}`;
            })
            .join("\n");
    }

    private async extractHighlightsFromFile(
        file: TFile,
    ): Promise<Annotation[]> {
        const content = await this.vault.read(file);
        return this.extractHighlights(content);
    }
    // TODO: refactor this to use a more efficient algorithm
    private mergeHighlights(
        existing: Annotation[],
        newHighlights: Annotation[],
    ): Annotation[] {
        const merged = [...existing];

        for (const newHighlight of newHighlights) {
            const existingIndex = merged.findIndex((eh) =>
                eh.chapter === newHighlight.chapter &&
                eh.pageno === newHighlight.pageno &&
                this.isHighlightTextEqual(eh.text, newHighlight.text)
            );

            if (existingIndex === -1) {
                merged.push(newHighlight);
            }
        }

        return merged.sort((a, b) => {
            // First sort by page number
            if (a.pageno !== b.pageno) {
                return a.pageno - b.pageno;
            }

            // If same page, sort by datetime
            const dateA = new Date(a.datetime);
            const dateB = new Date(b.datetime);
            return dateA.getTime() - dateB.getTime();
        });
    }

    private formatHighlights(highlights: Annotation[]): string {
        return highlights
            .map((h) =>
                `### Chapter: ${h.chapter}\n(*Date: ${h.datetime} - Page: ${h.pageno}*)\n\n${h.text}\n\n---\n`
            )
            .join("");
    }

    private async generateUniqueFileName(docProps: DocProps): Promise<string> {
        const fileName = this.generateFileName(docProps);
        return generateUniqueFilePath(
            this.vault,
            this.settings.highlightsFolder,
            fileName,
        );
    }

    private generateFileName(docProps: DocProps): string {
        const normalizedAuthors = this.normalizeFileName(docProps.authors);
        const normalizedTitle = this.normalizeFileName(docProps.title);
        const authorsArray = normalizedAuthors.split(",").map((author) =>
            author.trim()
        );
        const authorsString = authorsArray.join(" & ") || "Unknown Author";
        const fileName = `${authorsString} - ${normalizedTitle}.md`;

        const maxFileNameLength = 260 -
            this.settings.highlightsFolder.length - 1 - 4; // 4 for '.md'
        return fileName.length > maxFileNameLength
            ? `${fileName.slice(0, maxFileNameLength)}.md`
            : fileName;
    }

    normalizeFileName(fileName: string): string {
        return fileName.replace(/[\\/:*?"<>|]/g, "_").trim();
    }
}
