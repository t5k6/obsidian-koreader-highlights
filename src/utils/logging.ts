import { normalizePath, TFile, TFolder, type Vault } from "obsidian";

const formattedDate = getFormattedDate();
let isDebugMode = false;

/**
 * DebugLevel enumeration for controlling the verbosity of debug messages.
 */
enum DebugLevel {
    NONE = 0,
    INFO = 1,
    WARNING = 2,
    ERROR = 3,
}

/**
 * Set the current debug level.
 * @param level - The debug level to set: NONE, ERROR, WARNING, or INFO.
 */
export function setDebugLevel(level: DebugLevel): void {
    currentDebugLevel = level;
}

export function setDebugMode(debugMode: boolean) {
    isDebugMode = debugMode;
    if (debugMode) {
        setDebugLevel(DebugLevel.INFO);
    } else {
        setDebugLevel(DebugLevel.NONE);
    }
}

/**
 * Logs information messages if the current debug level is INFO.
 */
export function devLog(...args: unknown[]): void {
    if (currentDebugLevel >= DebugLevel.INFO) {
        console.log(...args.map((arg) => formatMessage(arg)));
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "INFO");
    }
}

/**
 * Logs warning messages if the current debug level is WARNING or above.
 */
export function devWarn(...args: string[]): void {
    if (currentDebugLevel >= DebugLevel.WARNING) {
        console.warn(...args);
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "WARNING");
    }
}

/**
 * Logs error messages if the current debug level is ERROR or above.
 */
export function devError(...args: unknown[]): void {
    if (currentDebugLevel >= DebugLevel.ERROR) {
        console.error(...args.map((arg) => formatMessage(arg)));
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "ERROR");
    }
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

/* Global variable to store the current debug level.
   Defaults to NONE so no debug logs are printed. */
let currentDebugLevel: DebugLevel = DebugLevel.NONE;

export class LogManager {
    private vault: Vault;
    private logDir: string;
    private logFile: TFile | null = null;
    private logBuffer: string[] = [];
    private isWriting = false;
    private flushTimer: NodeJS.Timeout | undefined;
    private static readonly MAX_BUFFER_SIZE = 1000;
    private static readonly FLUSH_INTERVAL = 1000; // 1 second

    constructor(vault: Vault, logDir: string) {
        this.vault = vault;
        this.logDir = normalizePath(logDir);
    }

    public async initialize(cleanupOptions?: {
        enabled: boolean;
        maxAgeDays?: number;
        maxFiles?: number;
    }): Promise<void> {
        try {
            const folder = this.vault.getAbstractFileByPath(this.logDir);

            if (!folder || !(folder instanceof TFolder)) {
                await this.vault.createFolder(this.logDir);
            } else if (cleanupOptions?.enabled) {
                await this.cleanupOldLogs(
                    cleanupOptions.maxAgeDays,
                    cleanupOptions.maxFiles,
                );
            }

            const levelName = DebugLevel[currentDebugLevel];
            const logFilePath = normalizePath(
                `${this.logDir}/koreader-importer_${formattedDate}_${levelName}.md`,
            );

            this.logFile = await this.vault.create(
                logFilePath,
                `[${levelName}] Log initialized at ${
                    new Date().toISOString()
                }\n`,
            );
        } catch (error) {
            console.error("Log initialization failed:", error);
            throw error;
        }
    }

    public async write(
        message: string,
        level: "INFO" | "WARNING" | "ERROR",
    ): Promise<void> {
        if (currentDebugLevel < DebugLevel.INFO) return;

        const timestamp = new Date().toISOString();
        this.logBuffer.push(`[${timestamp}] [${level}] ${message}`);

        if (this.logBuffer.length >= LogManager.MAX_BUFFER_SIZE) {
            await this.flush();
        } else if (!this.flushTimer) {
            this.flushTimer = setTimeout(
                () => this.flush(),
                LogManager.FLUSH_INTERVAL,
            );
        }
    }

    private async flush(): Promise<void> {
        if (this.isWriting || this.logBuffer.length === 0) return;

        this.isWriting = true;
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;

        const entries = [...this.logBuffer];
        this.logBuffer = [];

        try {
            if (this.logFile) {
                await this.vault.modify(
                    this.logFile,
                    (await this.vault.read(this.logFile)) + entries.join("\n"),
                );
            }
        } catch (e) {
            console.error("Failed to flush log buffer:", e);
            this.logBuffer.unshift(...entries);
        } finally {
            this.isWriting = false;
        }
    }

    private async cleanupOldLogs(
        maxAgeDays = 7,
        maxFiles?: number,
    ): Promise<void> {
        const folder = this.vault.getAbstractFileByPath(this.logDir);
        if (!folder || !(folder instanceof TFolder)) return;

        const now = Date.now();
        const cutoffTime = now - (maxAgeDays * 24 * 60 * 60 * 1000);
        const logFiles: { file: TFile; mtime: number }[] = [];

        // Collect and sort log files
        for (const file of folder.children) {
            if (
                file instanceof TFile &&
                file.name.startsWith("koreader-importer_")
            ) {
                const stat = await this.vault.adapter.stat(file.path);
                if (stat?.mtime) {
                    logFiles.push({ file, mtime: stat.mtime });
                }
            }
        }

        // Sort by modification time (oldest first)
        logFiles.sort((a, b) => a.mtime - b.mtime);

        // Delete files based on age and count
        for (const { file, mtime } of logFiles) {
            if (
                mtime < cutoffTime || (maxFiles && logFiles.length > maxFiles)
            ) {
                try {
                    await this.vault.delete(file);
                    devLog(`Deleted old log file: ${file.name}`);
                    logFiles.pop(); // Remove from count
                } catch (error) {
                    devError(
                        `Failed to delete old log file ${file.name}:`,
                        error,
                    );
                }
            } else {
                break; // Files are sorted, so we can stop checking
            }
        }
    }

    public static async promptForCleanup(
        vault: Vault,
        logDir: string,
    ): Promise<{
        enabled: boolean;
        maxAgeDays?: number;
        maxFiles?: number;
    }> {
        // Implementation could use Obsidian's dialog system
        // For now, we'll return default values
        return {
            enabled: true,
            maxAgeDays: 7,
        };
    }
}

// Global log manager instance
let logManager: LogManager | null = null;

// Update existing logging functions to use the LogManager
export async function initLogging(
    vault: Vault,
    logFolderPath: string,
    cleanupOptions?: {
        enabled: boolean;
        maxAgeDays?: number;
        maxFiles?: number;
    },
): Promise<string> {
    if (currentDebugLevel < DebugLevel.INFO) return "";

    logManager = new LogManager(vault, logFolderPath);
    await logManager.initialize(cleanupOptions);
    return logFolderPath;
}

export async function writeLog(
    message: string,
    level: "INFO" | "WARNING" | "ERROR",
): Promise<void> {
    if (logManager) {
        await logManager.write(message, level);
    }
}

function getFormattedDate(): string {
    const date = new Date();
    return date.toISOString()
        .replace(/[:.]/g, "-") // Replace colons and periods with hyphens
        .replace("T", "_"); // Replace the 'T' in ISO format with an underscore
}
