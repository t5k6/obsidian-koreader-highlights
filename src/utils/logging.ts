import { normalizePath, TFile, TFolder, type Vault } from "obsidian";
import { handleFileSystemError } from "./fileUtils";

let isDebugMode = false;

enum DebugLevel {
    NONE = 0,
    INFO = 1,
    WARNING = 2,
    ERROR = 3,
}

let currentDebugLevel: DebugLevel = DebugLevel.NONE;

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

export function devLog(...args: unknown[]): void {
    if (currentDebugLevel === DebugLevel.INFO) {
        console.log(...args.map((arg) => formatMessage(arg)));
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "INFO");
    }
}

export function devWarn(...args: string[]): void {
    if (currentDebugLevel >= DebugLevel.WARNING) {
        console.warn(...args);
        writeLog(args.map((arg) => formatMessage(arg)).join(" "), "WARNING");
    }
}

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

function getFormattedDate(): string {
    const date = new Date();
    return date.toISOString()
        .replace(/[:.]/g, "-") // Replace colons and periods with hyphens
        .replace("T", "_"); // Replace the 'T' in ISO format with an underscore
}

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
        const formattedDate = getFormattedDate();
        try {
            const folderExists = await this.vault.adapter.exists(this.logDir);

            if (!folderExists) {
                devLog(
                    `Log directory ${this.logDir} does not exist. Creating...`,
                );
                try {
                    await this.vault.createFolder(this.logDir);
                    devLog(
                        `Log directory created successfully: ${this.logDir}`,
                    );
                } catch (createError) {
                    console.error(
                        `LogManager: Failed to create log directory ${this.logDir}:`,
                        createError,
                    );
                    throw new Error(
                        `Failed to create log directory: ${
                            createError instanceof Error
                                ? createError.message
                                : String(createError)
                        }`,
                    );
                }
            } else {
                devLog(
                    `Log directory ${this.logDir} exists. Verifying type...`,
                );
                try {
                    const folderStat = await this.vault.adapter.stat(
                        this.logDir,
                    );
                    if (!folderStat || folderStat.type !== "folder") {
                        console.error(
                            `LogManager: Expected folder at ${this.logDir}, but found type '${folderStat?.type}'. Cannot initialize file logging.`,
                        );
                        throw new Error(
                            `Log path ${this.logDir} exists but is not a folder.`,
                        );
                    }
                    devLog(`Log directory ${this.logDir} verified as folder.`);
                    if (cleanupOptions?.enabled) {
                        await this.cleanupOldLogs(
                            cleanupOptions.maxAgeDays,
                            cleanupOptions.maxFiles,
                        );
                    }
                } catch (statError) {
                    console.error(
                        `LogManager: Failed to verify log directory type ${this.logDir}:`,
                        statError,
                    );
                    throw new Error(
                        `Failed to access log directory info: ${
                            statError instanceof Error
                                ? statError.message
                                : String(statError)
                        }`,
                    );
                }
            }

            const levelName = DebugLevel[currentDebugLevel];
            const logFilePath = normalizePath(
                `${this.logDir}/koreader-importer_${formattedDate}_${levelName}.md`,
            );

            const existingLogFile = await this.vault.getAbstractFileByPath(
                logFilePath,
            );
            if (existingLogFile && existingLogFile instanceof TFile) {
                this.logFile = existingLogFile;
                devLog(`Reusing existing log file: ${logFilePath}`);
            } else {
                this.logFile = await this.vault.create(
                    logFilePath,
                    `[${levelName}] Log initialized at ${
                        new Date().toISOString()
                    }\n`,
                );
            }
        } catch (error) {
            console.error("Log initialization failed:", error);
            handleFileSystemError(
                "initializing file logging",
                this.logDir,
                error,
                {
                    shouldThrow: false,
                    customNoticeMessage:
                        "File logging setup failed. Logs will only go to console.",
                },
            );
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

    async flush(): Promise<void> {
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
        maxFileCount?: number,
    ): Promise<void> {
        const folder = this.vault.getAbstractFileByPath(this.logDir);
        if (!folder || !(folder instanceof TFolder)) return;

        const now = Date.now();
        const cutoffTime = now - (maxAgeDays * 24 * 60 * 60 * 1000);
        const logFiles: { file: TFile; mtime: number }[] = [];

        // Collect log files
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

        // Delete old files
        let i = 0;
        while (i < logFiles.length) {
            const { file, mtime } = logFiles[i];
            if (
                mtime < cutoffTime ||
                (maxFileCount && logFiles.length - i > maxFileCount)
            ) {
                try {
                    await this.vault.delete(file);
                    logFiles.splice(i, 1); // Remove from array
                } catch (error) {
                    console.error(
                        `Failed to delete log file ${file.name}:`,
                        error,
                    );
                    i++;
                }
            } else {
                break;
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

export async function closeLogging(): Promise<void> {
    if (logManager) {
        await logManager.flush(); // Ensure buffer is written before unload
        logManager = null; // Release reference
        devLog("Logging flushed and closed.");
    }
}

export async function writeLog(
    message: string,
    level: "INFO" | "WARNING" | "ERROR",
): Promise<void> {
    if (logManager) {
        try {
            await logManager.write(message, level);
        } catch (error) {
            console.error("Error writing log entry:", error);
        }
    } else if (currentDebugLevel >= DebugLevel[level]) {
        console.log(`[LOG FALLBACK - ${level}] ${message}`);
    }
}
