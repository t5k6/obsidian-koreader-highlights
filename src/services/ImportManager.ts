import path from "node:path";
import { type App, normalizePath, Notice, TFile } from "obsidian";
import type {
    Annotation,
    KoReaderHighlightImporterSettings,
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
        private settings: KoReaderHighlightImporterSettings,
        private sdrFinder: SDRFinder,
        private metadataParser: MetadataParser,
        private databaseService: DatabaseService,
        private frontmatterGenerator: FrontmatterGenerator,
        private contentGenerator: ContentGenerator,
        private duplicateHandler: DuplicateHandler,
    ) {}

    async importHighlights(): Promise<void> {
        devLog("Starting KoReader highlight import process...");

        const isMountPointValid = await this.sdrFinder.checkMountPoint();
        if (!isMountPointValid) {
            new Notice(
                "Mount point is not valid or accessible. Please check settings.",
            );
            devError("Import process aborted: Invalid mount point.");
            return;
        }

        const modal = new ProgressModal(this.app);
        modal.open();

        try {
            const sdrFilePaths = await this.sdrFinder
                .findSdrDirectoriesWithMetadata();
            if (!sdrFilePaths || sdrFilePaths.length === 0) {
                new Notice(
                    "No KoReader highlight files (.sdr directories with metadata.lua) found.",
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

            // Reset duplicate handler state for this import session
            this.duplicateHandler.resetApplyToAll();

            for (const sdrPath of sdrFilePaths) {
                const baseName = path.basename(sdrPath);
                modal.updateProgress(completed, baseName);
                devLog(`Processing SDR: ${sdrPath}`);

                try {
                    // 1. Parse Metadata (use cache within parser)
                    const luaMetadata = await this.metadataParser.parseFile(
                        sdrPath,
                    );
                    if (!luaMetadata) {
                        devWarn(
                            `Skipping SDR due to parsing error or no metadata: ${sdrPath}`,
                        );
                        errors++;
                        continue; // Skip this file
                    }

                    // 2. Fetch Statistics
                    if (this.settings.frontmatter) {
                        try {
                            const stats = await this.databaseService
                                .getBookStatistics(
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

                    // 3. Handle missing Title/Author fallback
                    if (
                        !luaMetadata.docProps.authors &&
                        !luaMetadata.docProps.title
                    ) {
                        const fallbackName = getFileNameWithoutExt(sdrPath); // Use base name of SDR folder
                        luaMetadata.docProps.authors = fallbackName;
                        luaMetadata.docProps.title = fallbackName;
                        devLog(
                            `Using fallback name "${fallbackName}" for title/author.`,
                        );
                    }

                    // 4. Save Highlights (includes generation & duplicate check)
                    await this.saveHighlightsToFile(
                        luaMetadata,
                        path.basename(sdrPath),
                    );
                } catch (fileError) {
                    this.handleFileError(fileError, sdrPath);
                    errors++;
                } finally {
                    completed++;
                    modal.updateProgress(completed, baseName); // Update progress even on error
                }
            }

            if (errors > 0) {
                new Notice(
                    `KOReader Import: Completed with ${errors} error(s). Check console for details.`,
                );
            } else {
                new Notice(
                    "KOReader Import: Highlights imported successfully!",
                );
            }
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
    ): Promise<void> {
        const annotations = luaMetadata.annotations || [];
        if (annotations.length === 0) {
            devLog(
                `No annotations found for "${luaMetadata.docProps.title}". Skipping file creation.`,
            );
            return;
        }

        // 1. Generate File Name
        const fileName = generateObsidianFileName(
            luaMetadata.docProps,
            this.settings.highlightsFolder,
            originalSdrName, // Pass the SDR name for fallback
        );
        const targetFilePath = normalizePath(
            `${this.settings.highlightsFolder}/${fileName}`,
        );

        // 2. Generate Content
        const frontmatterString = this.frontmatterGenerator
            .generateYamlFromLuaMetadata(
                luaMetadata,
                this.settings.frontmatter,
            );
        const highlightsContent = await this.contentGenerator
            .generateHighlightsContent(annotations, luaMetadata);
        const fullContent = `${frontmatterString}\n\n${highlightsContent}`;

        devLog(`Generated content for: ${fileName}`);

        // 3. Handle Duplicates & Save
        let fileCreatedOrModified = false;

        const potentialDuplicates = await this.duplicateHandler
            .findPotentialDuplicates(luaMetadata.docProps);

        if (potentialDuplicates.length > 0) {
            devLog(
                `Found ${potentialDuplicates.length} potential duplicate(s) for: ${fileName}`,
            );
            fileCreatedOrModified = await this.processDuplicates(
                potentialDuplicates,
                annotations,
                luaMetadata,
                fullContent,
                targetFilePath,
            );
        }

        // If no duplicates were found, or if 'keep-both'/'skip' didn't result in modification/creation of the target path
        if (!fileCreatedOrModified) {
            const existingFile = this.app.vault.getAbstractFileByPath(
                targetFilePath,
            );
            if (!existingFile) {
                devLog(
                    `No duplicates handled file creation for ${targetFilePath}. Creating file.`,
                );
                await this.createOrUpdateFile(targetFilePath, fullContent);
            } else {
                devLog(
                    `Target file ${targetFilePath} already exists and was potentially handled by duplicate process (or skipped).`,
                );
            }
        }
    }

    private async processDuplicates(
        potentialDuplicates: TFile[],
        newAnnotations: Annotation[],
        luaMetadata: LuaMetadata,
        newContent: string,
        intendedTargetPath: string,
    ): Promise<boolean> {
        let fileHandled = false;

        for (const existingFile of potentialDuplicates) {
            devLog(`Analyzing duplicate: ${existingFile.path}`);
            const analysis = await this.duplicateHandler.analyzeDuplicate(
                existingFile,
                newAnnotations,
                luaMetadata,
            );

            const { choice, applyToAll } = await this.duplicateHandler
                .handleDuplicate(analysis, newContent);

            // Determine if this specific choice resulted in handling the file
            if (choice === "replace" || choice === "merge") {
                fileHandled = true;
                devLog(
                    `Duplicate handled via '${choice}' for: ${existingFile.path}`,
                );
            } else if (choice === "keep-both") {
                fileHandled = true;
                devLog(`Duplicate handled via '${choice}', new file created.`);
            } else { // choice === 'skip'
                devLog(`Duplicate skipped for: ${existingFile.path}`);
            }

            // If user chose 'Apply to All', we break the loop if a definitive action was taken.
            // If they chose 'skip' and 'apply to all', we continue skipping.
            // If they chose 'keep-both' and 'apply to all', new files will be made for remaining duplicates.
            if (applyToAll && choice !== "skip") {
                // Let DuplicateHandler manage the applyToAll state internally.
            }
        }

        return fileHandled;
    }

    private async createOrUpdateFile(
        filePath: string,
        content: string,
    ): Promise<void> {
        try {
            await ensureParentDirectory(this.app.vault, filePath);
            const file = this.app.vault.getAbstractFileByPath(filePath);

            if (file instanceof TFile) {
                devLog(`Modifying existing file: ${filePath}`);
                await this.app.vault.modify(file, content);
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
