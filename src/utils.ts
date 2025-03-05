import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join as node_join } from "node:path";
import {
    normalizePath,
    Notice,
    type TFile,
    TFolder,
    type Vault,
} from "obsidian";
import type { Annotation, DocProps } from "./types";

let isDebugMode = false;
let logFilePath: string;
let logFile: TFile | null = null;
let logVault: Vault;

const formattedDate = getFormattedDate();

/**
 * DebugLevel enumeration for controlling the verbosity of debug messages.
 */
enum DebugLevel {
    NONE = 0,
    INFO = 1,
    WARNING = 2,
    ERROR = 3,
}

/* Global variable to store the current debug level.
   Defaults to NONE so no debug logs are printed. */
let currentDebugLevel: DebugLevel = DebugLevel.NONE;

/**
 * Set the current debug level.
 * @param level - The debug level to set: NONE, ERROR, WARNING, or INFO.
 */
export function setDebugLevel(level: DebugLevel): void {
    currentDebugLevel = level;
}

/**
 * Logs information messages if the current debug level is INFO.
 *
 * When the level is set to INFO, all messages will be logged.
 */
export function devLog(...args: unknown[]): void {
    if (currentDebugLevel >= DebugLevel.INFO) {
        console.log(...args.map((arg) => formatMessage(arg)));
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "INFO");
    }
}

/**
 * Logs warning messages if the current debug level is WARNING or above.
 *
 * When the debug level is WARNING, this will log both warnings and errors.
 */
export function devWarn(...args: string[]): void {
    if (currentDebugLevel >= DebugLevel.WARNING) {
        console.warn(...args);
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "WARNING");
    }
}

/**
 * Logs error messages if the current debug level is ERROR or above.
 *
 * When confirgured as ERROR, only errors will be logged.
 */
export function devError(...args: unknown[]): void {
    if (currentDebugLevel >= DebugLevel.ERROR) {
        console.error(...args.map((arg) => formatMessage(arg)));
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "ERROR");
    }
}

function getFormattedDate(): string {
    const date = new Date();
    return date.toISOString()
        .replace(/[:.]/g, "-") // Replace colons and periods with hyphens
        .replace("T", "_"); // Replace the 'T' in ISO format with an underscore
}

export async function initLogging(
    vault: Vault,
    logFolderPath: string,
): Promise<string> {
    logVault = vault;
    const logDir = normalizePath(logFolderPath);

    try {
        const folder = vault.getAbstractFileByPath(logDir);

        if (!folder || !(folder instanceof TFolder)) {
            await vault.createFolder(logDir);
        }
    } catch (error) {
        if ((error as Error).message !== "Folder already exists.") {
            console.error("Failed to create or access log folder:", error);
            throw error;
        }
        console.log(`Log folder already exists: ${logDir}`);
    }

    logFilePath = normalizePath(
        `${logDir}/koreader-importer_${formattedDate}.md`,
    );

    logFile = await vault.create(
        logFilePath,
        `Log initialized at ${new Date().toISOString()}\n`,
    );

    return logFilePath;
}

export async function writeLog(
    message: string,
    level: "INFO" | "WARNING" | "ERROR",
): Promise<void> {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level}] ${message}\n`;

    if (logFile) {
        try {
            await logVault.modify(
                logFile,
                (await logVault.read(logFile)) + logEntry,
            );
        } catch (error) {
            console.error("Failed to append to log file:", error);
        }
    } else {
        console.error(
            "Log file not initialized. Cannot write log entry:",
            logEntry,
        );
    }
}

export function setDebugMode(debugMode: boolean) {
    isDebugMode = debugMode;
}

export async function generateUniqueFilePath(
    vault: Vault,
    baseDir: string,
    fileName: string,
    maxFileNameLength?: number,
): Promise<string> {
    const normalizedBaseDir = normalizePath(baseDir);
    let normalizedFileName = normalizePath(fileName);

    // Truncate the file name if it exceeds the maximum length
    if (maxFileNameLength && normalizedFileName.length > maxFileNameLength) {
        const ext = normalizedFileName.substring(
            normalizedFileName.lastIndexOf("."),
        );
        const baseName = normalizedFileName.substring(
            0,
            normalizedFileName.lastIndexOf("."),
        );
        normalizedFileName = `${
            baseName.slice(0, maxFileNameLength - ext.length)
        }${ext}`;
    }

    // Ensure the file name is unique
    let counter = 1;
    let newPath = normalizePath(`${normalizedBaseDir}/${normalizedFileName}`);
    const baseName = normalizedFileName.substring(
        0,
        normalizedFileName.lastIndexOf("."),
    );
    const ext = normalizedFileName.substring(
        normalizedFileName.lastIndexOf("."),
    );

    while (vault.getAbstractFileByPath(newPath)) {
        newPath = normalizePath(
            `${normalizedBaseDir}/${baseName} (${counter})${ext}`,
        );
        counter++;
    }

    return newPath;
}

export async function ensureParentDirectory(
    vault: Vault,
    filePath: string,
): Promise<void> {
    const dirPath = normalizePath(
        filePath.substring(0, filePath.lastIndexOf("/")),
    );
    const dirExists = vault.getFolderByPath(dirPath);

    if (!dirExists) {
        await vault.createFolder(dirPath);
    }
}

export async function findAndReadMetadataFile(
    directory: string,
    allowedFileTypes: string[],
): Promise<string | null> {
    const isFileTypeFilterEmpty = !allowedFileTypes.length ||
        (allowedFileTypes.length === 1 && !allowedFileTypes[0]);

    const searchFiles = async (files: string[]) => {
        for (const file of files) {
            if (isFileTypeFilterEmpty && /^metadata\..+\.lua$/.test(file)) {
                const luaFilePath = node_join(directory, file);
                try {
                    const stats = await stat(luaFilePath);
                    if (stats.isFile()) {
                        devLog(`File found: ${luaFilePath}`);
                        return await readFile(luaFilePath, "utf-8");
                    }
                    devWarn(`Skipping non-file: ${luaFilePath}`);
                } catch (error) {
                    const e = error as NodeJS.ErrnoException;
                    await handleDirectoryError(luaFilePath, e);
                }
            } else if (
                !isFileTypeFilterEmpty &&
                allowedFileTypes.some((type) => file === `metadata.${type}.lua`)
            ) {
                const luaFilePath = node_join(directory, file);
                try {
                    const stats = await stat(luaFilePath);
                    if (stats.isFile()) {
                        devLog(`File found: ${luaFilePath}`);
                        return await readFile(luaFilePath, "utf-8");
                    }
                    devWarn(`Skipping non-file: ${luaFilePath}`);
                } catch (error) {
                    const e = error as NodeJS.ErrnoException;
                    await handleDirectoryError(luaFilePath, e);
                }
            }
        }
        return null;
    };

    try {
        const files = await readdir(directory);
        return searchFiles(files);
    } catch (error) {
        devError(`Error reading directory ${directory}:`, error);
        return null;
    }
}

export function generateFileName(
    docProps: DocProps,
    highlightsFolder: string,
): string {
    const authors = docProps.authors || "Unknown Author";
    const title = docProps.title || "Untitled";
    const normalizedAuthors = normalizeFileName(authors);
    const normalizedTitle = normalizeFileName(title);
    const authorsArray = normalizedAuthors.split(",").map((author) =>
        author.trim()
    );
    const authorsString = authorsArray.join(" & ") || "Unknown Author";
    const fileName = `${authorsString} - ${normalizedTitle}.md`;

    const maxFileNameLength = 260 - highlightsFolder.length - 1 - 4; // 4 for '.md'
    return fileName.length > maxFileNameLength
        ? `${fileName.slice(0, maxFileNameLength)}.md`
        : fileName;
}

function normalizeFileName(fileName: string): string {
    return fileName.replace(/[\\/:*?"<>|]/g, "_").trim();
}

export function getFileNameWithoutExt(filePath: string): string {
    const fileName = basename(filePath);
    const lastDotIndex = fileName.lastIndexOf(".");
    return lastDotIndex === -1 ? fileName : fileName.slice(0, lastDotIndex);
}

function formatMessage(arg: unknown): string {
    if (arg instanceof Error) {
        return arg.message;
    }
    if (typeof arg === "object" && arg !== null) {
        return JSON.stringify(arg, null, 2);
    }
    return String(arg);
}

export async function handleDirectoryError(
    filePath: string,
    error: NodeJS.ErrnoException,
) {
    switch (error.code) {
        case "ENOENT":
            devError(`File/Directory not found: ${filePath}`);
            new Notice(`File/Directory not found: ${filePath}`);
            break;
        case "EPERM":
            devError(`Permission denied for file/directory: ${filePath}`);
            break;
        case "EACCES":
            devError(`Access denied for file/directory: ${filePath}`);
            break;
        default:
            devError(`Error reading file/directory ${filePath}:`, error);
    }
}

export function formatHighlight(highlight: Annotation): string {
    // Create the header with chapter, date, and page info
    const header = highlight.chapter
        ? `### Chapter: ${highlight.chapter}\n(*Date: ${
            formatDate(highlight.datetime)
        } - Page: ${highlight.pageno}*)\n\n`
        : `(*Date: ${
            formatDate(highlight.datetime)
        } - Page: ${highlight.pageno}*)\n\n`;

    // Add the note section if a note exists
    const noteSection = highlight.note
        ? `\n\n> [!NOTE] Note\n${
            highlight.note
                .split("\n")
                .map((line) => `> ${line.trim()}`)
                .join("\n")
        }`
        : "";

    // Combine header, highlighted text, and note, with separators
    return `${header}${highlight.text}${noteSection}\n\n---\n`;
}

function formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export function secondsToHoursMinutes(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
}

export function formatUnixTimestamp(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

export function formatPercent(percent: number): string {
    return `${Math.round(percent)}%`;
}
