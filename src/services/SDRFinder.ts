import type { Dirent } from "node:fs";
import { access, readdir, readFile, stat as fsStat } from "node:fs/promises";
import { platform } from "node:os";
import { join as node_join } from "node:path";
import { Notice } from "obsidian";
import type { KoReaderHighlightImporterSettings } from "../types";
import { handleFileSystemError } from "../utils/fileUtils";
import { devError, devLog, devWarn } from "../utils/logging";

const SDR_DIR_SUFFIX = ".sdr";
const METADATA_REGEX = /^metadata\.(.+)\.lua$/i; // Matches metadata.<filetype>.lua

export class SDRFinder {
    private sdrFilesCache = new Map<string, string[]>(); // Cache: key -> list of SDR_DIR_PATHS
    private metadataFileCache = new Map<string, string | null>(); // Cache: SDR_DIR_PATH -> METADATA_FILE_NAME_OR_NULL
    private cacheKey: string | null = null;

    constructor(private settings: KoReaderHighlightImporterSettings) {
        this.updateCacheKey();
    }

    updateSettings(newSettings: KoReaderHighlightImporterSettings): void {
        const oldKey = this.cacheKey;
        this.settings = newSettings;
        this.updateCacheKey();
        if (this.cacheKey !== oldKey) {
            this.clearCache();
            devLog("SDRFinder settings updated, cache cleared.");
        }
    }

    private updateCacheKey(): void {
        this.cacheKey = `${this.settings.koboMountPoint ?? "nokey"}:${
            this.settings.excludedFolders.join(",")
        }:${this.settings.allowedFileTypes.join(",")}`;
    }

    async checkMountPoint(): Promise<boolean> {
        if (!this.settings.koboMountPoint) {
            new Notice(
                "KOReader Importer: Mount point not specified in settings.",
                5000,
            );
            return false;
        }

        try {
            const stats = await fsStat(this.settings.koboMountPoint);
            if (!stats.isDirectory()) {
                new Notice(
                    `KOReader Importer: Specified mount point "${this.settings.koboMountPoint}" is not a directory.`,
                    5000,
                );
                return false;
            }
            // devLog(
            //     "KoReader mount point is valid:",
            //     this.settings.koboMountPoint,
            // );
            this.updateCacheKey();
            return true;
        } catch (error) {
            devWarn(
                `Configured mount point "${this.settings.koboMountPoint}" not accessible. Trying common locations...`,
                error instanceof Error ? error.message : String(error),
            );

            // Try common mount locations (adjust patterns as needed for different OS)
            const candidates: string[] = [];
            if (platform() === "darwin") {
                // macOS: /Volumes/KOBOeReader
                try {
                    const volumes = await readdir("/Volumes", {
                        withFileTypes: true,
                    });
                    for (const entry of volumes) {
                        if (
                            entry.isDirectory() &&
                            entry.name.toLowerCase().includes("kobo")
                        ) {
                            candidates.push(node_join("/Volumes", entry.name));
                        }
                    }
                } catch { /* ignore */ }
            } else if (platform() === "linux") {
                // Linux: /media/*/KOBOeReader or /run/media/*/KOBOeReader
                const linuxRoots = ["/media", "/run/media"];
                for (const root of linuxRoots) {
                    try {
                        const users = await readdir(root, {
                            withFileTypes: true,
                        });
                        for (const user of users) {
                            if (user.isDirectory()) {
                                const userPath = node_join(root, user.name);
                                try {
                                    const devices = await readdir(userPath, {
                                        withFileTypes: true,
                                    });
                                    for (const device of devices) {
                                        if (
                                            device.isDirectory() &&
                                            device.name.toLowerCase().includes(
                                                "kobo",
                                            )
                                        ) {
                                            candidates.push(
                                                node_join(
                                                    userPath,
                                                    device.name,
                                                ),
                                            );
                                        }
                                    }
                                } catch { /* ignore */ }
                            }
                        }
                    } catch { /* ignore */ }
                }
            } else if (platform() === "win32") {
                // Windows: check all drive letters for KoboReader.sqlite at root
                const driveLetters = "DEFGHIJKLMNOPQRSTUVWXYZ".split("");
                for (const letter of driveLetters) {
                    const root = `${letter}:\\`;
                    try {
                        // Kobo devices always have KoboReader.sqlite at root
                        await access(node_join(root, "KoboReader.sqlite"));
                        candidates.push(root);
                    } catch { /* ignore */ }
                }
            }

            for (const mountPath of candidates) {
                try {
                    const stats = await fsStat(mountPath);
                    if (stats.isDirectory()) {
                        this.settings.koboMountPoint = mountPath;
                        await this.notifySettingsChanged();
                        new Notice(
                            `Auto-detected Kobo device at "${mountPath}". Settings updated.`,
                            5000,
                        );
                        devLog(`Using auto-detected mount point: ${mountPath}`);
                        this.updateCacheKey();
                        return true;
                    }
                } catch { /* ignore and continue */ }
            }

            // If no common mount point found
            handleFileSystemError(
                "checking configured mount point",
                this.settings.koboMountPoint,
                error,
                {
                    customNoticeMessage:
                        `Mount point "${this.settings.koboMountPoint}" inaccessible. Trying alternatives...`,
                }, // Don't throw yet, allow auto-detect
            );
            new Notice(
                "KOReader Importer: Mount point inaccessible. Please check path and device connection in settings.",
                7000,
            );
            return false;
        }
    }

    public async findSdrDirectoriesWithMetadata(): Promise<string[]> {
        if (!this.cacheKey) {
            devError("SDRFinder cache key is not set. Cannot find files.");
            return [];
        }

        const cachedResult = this.sdrFilesCache.get(this.cacheKey);
        if (cachedResult) {
            devLog(
                `Using cached SDR directory list (${cachedResult.length} entries).`,
            );
            return cachedResult;
        }

        devLog(
            `Scanning for SDR directories in: ${this.settings.koboMountPoint}`,
        );
        const sdrDirectories: string[] = [];
        const excludedSet = new Set(
            this.settings.excludedFolders.map((f) => f.trim()).filter(Boolean),
        );
        const rootDir = this.settings.koboMountPoint;

        if (!rootDir) {
            devError("Cannot scan SDR files: Mount point is not set.");
            // new Notice("Mount point not set. Cannot scan for SDR files."); // Already handled by checkMountPoint
            return [];
        }

        const traverseDir = async (currentDirectory: string): Promise<void> => {
            let entries: Dirent[];
            try {
                entries = await readdir(currentDirectory, {
                    withFileTypes: true,
                });
            } catch (error) {
                handleFileSystemError(
                    "reading directory contents", // Operation description
                    currentDirectory,
                    error,
                    // Don't throw, just skip this unreadable directory
                    {
                        shouldThrow: false,
                        customNoticeMessage:
                            `Could not read directory: ${currentDirectory}`,
                    },
                );
                return; // Skip this directory
            }

            const promises = entries.map(async (entry) => {
                const fullPath = node_join(currentDirectory, entry.name);

                // Skip explicitly excluded folders/files
                if (excludedSet.has(entry.name)) {
                    // devLog(`Skipping excluded entry: ${fullPath}`); // Can be noisy
                    return;
                }

                if (entry.isDirectory()) {
                    // 1. Check if it's an SDR directory
                    if (entry.name.endsWith(SDR_DIR_SUFFIX)) {
                        // Now, check if this SDR directory contains a valid metadata file
                        const metadataFileName = await this.getMetadataFileName(
                            fullPath,
                        );
                        if (metadataFileName) {
                            sdrDirectories.push(fullPath);
                            // this.metadataFileCache.set(fullPath, metadataFileName); // getMetadataFileName already caches
                            devLog(
                                `Found valid SDR directory: ${fullPath} (metadata: ${metadataFileName})`,
                            );
                        } else {
                            // Optional: Log SDR dirs that don't have *allowed* metadata
                            // devWarn(`SDR directory ${fullPath} does not contain a valid/allowed metadata file.`);
                        }
                        return; // Don't recurse into SDR directories themselves
                    }
                    // 2. Recurse into non-SDR directories
                    // Avoid recursing into common system/hidden dirs that might not be in explicit excludes
                    // but are unlikely to contain books. This is a heuristic.
                    if (
                        !entry.name.startsWith(".") &&
                        entry.name !== "$RECYCLE.BIN" &&
                        entry.name !== "System Volume Information"
                    ) {
                        await traverseDir(fullPath);
                    } else {
                        // devLog(`Skipping recursion into potentially problematic directory: ${fullPath}`);
                    }
                }
            });

            await Promise.all(promises);
        };

        try {
            await traverseDir(rootDir);
            this.sdrFilesCache.set(this.cacheKey, sdrDirectories);
            devLog(
                `Scan finished. Found ${sdrDirectories.length} valid SDR directories.`,
            );
            return sdrDirectories;
        } catch (error) {
            // This catch is for unexpected errors during the overall traversal setup,
            // not individual directory read errors which are handled inside traverseDir.
            handleFileSystemError(
                "SDR directory traversal process",
                rootDir,
                error,
                {
                    shouldThrow: false,
                    customNoticeMessage:
                        "An error occurred while scanning for SDR directories.",
                },
            );
            return [];
        }
    }

    private async getMetadataFileName(
        sdrDirectoryPath: string,
    ): Promise<string | null> {
        const cachedName = this.metadataFileCache.get(sdrDirectoryPath);
        if (cachedName !== undefined) {
            return cachedName;
        }

        const allowedTypes = this.settings.allowedFileTypes.map((t) =>
            t.trim().toLowerCase()
        ).filter(Boolean);
        const allowAllTypes = allowedTypes.length === 0;

        try {
            const filesInSdr = await readdir(sdrDirectoryPath);
            for (const fileName of filesInSdr) {
                const match = fileName.match(METADATA_REGEX);
                if (match) {
                    const fileTypeInName = match[1]?.toLowerCase(); // e.g., "epub"

                    if (
                        allowAllTypes ||
                        (fileTypeInName &&
                            allowedTypes.includes(fileTypeInName))
                    ) {
                        const fullMetadataPath = node_join(
                            sdrDirectoryPath,
                            fileName,
                        );
                        try {
                            const stats = await fsStat(fullMetadataPath);
                            if (stats.isFile()) {
                                this.metadataFileCache.set(
                                    sdrDirectoryPath,
                                    fileName,
                                );
                                return fileName;
                            }
                        } catch (statError) {
                            // Log and continue, this specific file might be inaccessible
                            handleFileSystemError(
                                "getting status of potential metadata file",
                                fullMetadataPath,
                                statError,
                            );
                        }
                    }
                }
            }
        } catch (dirError) {
            // Error reading the SDR directory itself, likely can't proceed with this directory
            handleFileSystemError(
                "reading SDR directory",
                sdrDirectoryPath,
                dirError,
            );
            this.metadataFileCache.set(sdrDirectoryPath, null);
            return null; // Can't read this directory
        }

        this.metadataFileCache.set(sdrDirectoryPath, null);
        return null;
    }

    async readMetadataFileContent(
        sdrDirectoryPath: string,
    ): Promise<string | null> {
        const metadataFileName = await this.getMetadataFileName(
            sdrDirectoryPath,
        );
        if (!metadataFileName) {
            // devLog already handled by getMetadataFileName or its fs error handler
            return null;
        }
        const fullMetadataPath = node_join(sdrDirectoryPath, metadataFileName);
        try {
            devLog(`Reading metadata file content from: ${fullMetadataPath}`);
            return await readFile(fullMetadataPath, "utf-8");
        } catch (readError) {
            // Reading the specific metadata file failed.
            handleFileSystemError(
                "reading metadata file content",
                fullMetadataPath,
                readError,
                { shouldThrow: false }, // Or true if one failed read should stop processing this SDR
            );
            return null; // Indicate failure to read this specific file
        }
    }

    clearCache(): void {
        this.sdrFilesCache.clear();
        devLog("SDRFinder cache cleared.");
    }

    private async notifySettingsChanged(): Promise<void> {
        console.warn(
            "SDRFinder: Mount point auto-detected. Manual settings save might be required in Obsidian UI.",
        );
    }
}
