import { type App, TFile, type Vault } from "obsidian";
import { normalizePath } from "obsidian";
import type {
    Annotation,
    DocProps,
    DuplicateChoice,
    IDuplicateHandlingModal,
    LuaMetadata,
} from "./types";
import { devError, devLog } from "./utils";

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
    currentMatch: DuplicateMatch | null = null;
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
    ) {}

    async handleDuplicate(
        match: DuplicateMatch,
        newContent: string,
    ): Promise<{ choice: DuplicateChoice; applyToAll: boolean }> {
        try {
            this.currentMatch = match;

            // Reset state if not applying to all
            if (!this.applyToAll && this.applyToAllChoice !== null) {
                this.applyToAllChoice = null;
            }

            // If applyToAll is true, use the previously chosen action
            if (this.applyToAll && this.applyToAllChoice !== null) {
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
                if (!this.currentMatch) {
                    return;
                }
                const newFileName = this.generateUniqueFileName(
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
                file.path.startsWith(this.settings.highlightsFolder) &&
                file instanceof TFile
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

    private extractFrontmatter(content: string): Record<string, string> {
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!frontmatterMatch) return {};

        const frontmatter: Record<string, string> = {};
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
        frontmatter: Record<string, string>,
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

    // TODO: refactor this to use a more efficient algorithm
    private extractHighlights(content: string): Annotation[] {
        const highlights: Annotation[] = [];
        const highlightRegex =
            /### Chapter: (.*?)\n\(\*Date: (.*?) - Page: (\d+)\*\)\n\n(.*?)\n\n---/gs;

        let match: RegExpExecArray | null;
        do {
            match = highlightRegex.exec(content);
            if (match) {
                highlights.push({
                    chapter: match[1],
                    datetime: match[2],
                    pageno: Number.parseInt(match[3]),
                    text: match[4],
                } as Annotation);
            }
        } while (match !== null);

        return highlights;
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
        const existingHighlights = await this.extractHighlightsFromFile(
            existingFile,
        );
        const newHighlights = this.extractHighlights(newContent);

        const mergedHighlights = this.mergeHighlights(
            existingHighlights,
            newHighlights,
        );

        return this.formatMergedContent(newContent, mergedHighlights);
    }

    private async extractHighlightsFromFile(
        file: TFile,
    ): Promise<Annotation[]> {
        const content = await this.vault.read(file);
        return this.extractHighlights(content);
    }

    private formatMergedContent(
        newContent: string,
        mergedHighlights: Annotation[],
    ): string {
        // Preserve frontmatter from new content
        const frontmatter = newContent.match(/^---\n[\s\S]*?\n---\n\n/)?.[0] ||
            "";
        const highlightsContent = this.formatHighlights(mergedHighlights);

        return `${frontmatter}${highlightsContent}`;
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

    private generateUniqueFileName(
        docProps: DocProps,
    ): string {
        const { vault } = this;
        const fileName = this.generateFileName(docProps);
        const dir = normalizePath(
            `${this.settings.highlightsFolder}/`,
        );
        let counter = 1;
        let newPath = normalizePath(
            `${dir}/${fileName}`,
        );

        const baseName = fileName.substring(0, fileName.lastIndexOf("."));
        const ext = fileName.substring(fileName.lastIndexOf("."));

        while (this.vault.getAbstractFileByPath(newPath)) {
            newPath = `${dir}${baseName} (${counter})${ext}`;
            counter++;
        }
        return newPath;
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
