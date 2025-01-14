import { basename } from "node:path";
import { normalizePath, type TFile, TFolder, type Vault } from "obsidian";

let isDebugMode = false;
let logFilePath: string;
let logFile: TFile | null = null;
let logVault: Vault;

const formattedDate = getFormattedDate();

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

export function devLog(...args: string[]) {
    if (isDebugMode) {
        console.log(...args);
        writeLog(args.join(" "), "INFO");
    }
}
export function devWarn(...args: string[]) {
    if (isDebugMode) {
        console.warn(...args);
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "WARNING");
    }
}

export function devError(...args: unknown[]): void {
    if (isDebugMode) {
        console.error(...args.map((arg) => formatMessage(arg)));
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "ERROR");
    }
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
    if (error.code === "ENOENT") {
        devError(`File/Directory not found: ${filePath}`);
    } else if (error.code === "EPERM") {
        devError(`Permission denied for file/directory: ${filePath}`);
    } else {
        devError(`Error reading file/directory ${filePath}:`, error);
    }
}
