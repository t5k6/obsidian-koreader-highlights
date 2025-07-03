import { normalizePath, TFile, TFolder, type Vault } from "obsidian";

let isDebugFileLoggingEnabled = false;

export enum DebugLevel {
	NONE = 0,
	INFO = 1, // Most verbose: Info, Warnings, Errors
	WARNING = 2, // Medium: Warnings, Errors
	ERROR = 3, // Least verbose (active): Errors only
}

let currentConsoleLogLevel: DebugLevel = DebugLevel.NONE;

export function setDebugLevel(level: DebugLevel): void {
	if (level in DebugLevel && typeof level === "number") {
		currentConsoleLogLevel = level;
	}
}

export function setDebugMode(enableFileLog: boolean) {
	isDebugFileLoggingEnabled = enableFileLog;
	if (enableFileLog && currentConsoleLogLevel === DebugLevel.NONE) {
		currentConsoleLogLevel = DebugLevel.INFO;
	}
}

function formatMessage(arg: unknown): string {
	if (arg instanceof Error) {
		return arg.message + (arg.stack ? `\nStack: ${arg.stack}` : "");
	}
	if (typeof arg === "object" && arg !== null) {
		try {
			return JSON.stringify(arg, null, 2);
		} catch (e) {
			return "[Unserializable Object]";
		}
	}
	return String(arg);
}

function formatArgs(args: unknown[]): string {
	return args.map((arg) => formatMessage(arg)).join(" ");
}

export function devLog(...args: unknown[]): void {
	if (currentConsoleLogLevel === DebugLevel.INFO) {
		console.log(...args.map((arg) => formatMessage(arg)));
	}
	if (isDebugFileLoggingEnabled && logManager) {
		logManager.write(formatArgs(args), "INFO");
	}
}

export function devWarn(...args: unknown[]): void {
	if (
		currentConsoleLogLevel === DebugLevel.INFO ||
		currentConsoleLogLevel === DebugLevel.WARNING
	) {
		console.warn(...args.map((arg) => formatMessage(arg)));
	}
	if (isDebugFileLoggingEnabled && logManager) {
		logManager.write(formatArgs(args), "WARNING");
	}
}

export function devError(...args: unknown[]): void {
	if (currentConsoleLogLevel !== DebugLevel.NONE) {
		// Any active level
		console.error(...args.map((arg) => formatMessage(arg)));
	}
	if (isDebugFileLoggingEnabled && logManager) {
		logManager.write(formatArgs(args), "ERROR");
	}
}

function getFormattedDate(): string {
	const date = new Date();
	return date.toISOString().replace(/[:.]/g, "-").replace("T", "_");
}

async function ensureFolder(vault: Vault, dir: string) {
	const parts = dir.split("/");
	let current = "";
	for (const p of parts) {
		current = current ? `${current}/${p}` : p;
		if (!(await vault.adapter.exists(current))) {
			await vault.createFolder(current); // creates one level only
		}
	}
}

export class LogManager {
	private vault: Vault;
	public logDir: string;
	public logFile: TFile | null = null;
	private logBuffer: string[] = [];
	private isWriting = false;
	public flushTimer: NodeJS.Timeout | undefined;
	private static readonly MAX_BUFFER_SIZE = 100;
	private static readonly FLUSH_INTERVAL = 500;

	constructor(vault: Vault, logDir: string) {
		this.vault = vault;
		this.logDir = normalizePath(logDir);
	}

	public async initialize(cleanupOptions?: {
		enabled: boolean;
		maxAgeDays?: number;
		maxFiles?: number;
	}): Promise<void> {
		const levelForFileName = "ALL";
		const formattedDate = getFormattedDate();
		const logFilePath = normalizePath(
			`${this.logDir}/koreader-importer_${formattedDate}_${levelForFileName}.md`,
		);
		const initialContent = `Log initialized at ${new Date().toISOString()} (File Log captures all levels. Console Level: ${
			DebugLevel[currentConsoleLogLevel]
		})\n`;

		try {
			await ensureFolder(this.vault, this.logDir);

			let fileHandle = this.vault.getAbstractFileByPath(logFilePath);

			// If path exists but it's a folder, that's a problem.
			if (fileHandle && !(fileHandle instanceof TFile)) {
				console.error(
					`Log path ${logFilePath} exists but is a folder. Logging disabled.`,
				);
				throw new Error("Log path is a folder");
			}

			// If file doesn't exist, create it.
			if (!fileHandle) {
				fileHandle = await this.vault.create(logFilePath, initialContent);
			}

			this.logFile = fileHandle as TFile;
		} catch (error) {
			console.error("LogManager.initialize internal error:", error);
			this.logFile = null;
			throw error; 
		}

		if (cleanupOptions?.enabled) {
			await this.cleanupOldLogs(
				cleanupOptions.maxAgeDays,
				cleanupOptions.maxFiles,
			);
		}
	}

	public async write(
		message: string,
		level: "INFO" | "WARNING" | "ERROR",
	): Promise<void> {
		if (!this.logFile) return; // Only write if a log file is successfully initialized

		const timestamp = new Date().toISOString();
		this.logBuffer.push(`[${timestamp}] [${level}] ${message}`);

		if (
			this.logBuffer.length >= LogManager.MAX_BUFFER_SIZE ||
			level === "ERROR"
		) {
			await this.flush();
		} else if (!this.flushTimer) {
			this.flushTimer = setTimeout(
				() => this.flush(),
				LogManager.FLUSH_INTERVAL,
			);
		}
	}

	async flush(): Promise<void> {
		if (this.isWriting || this.logBuffer.length === 0 || !this.logFile) {
			return;
		}
		this.isWriting = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;

		const entriesToFlush = [...this.logBuffer];
		this.logBuffer = [];

		try {
			const currentContent = await this.vault.read(this.logFile);
			await this.vault.modify(
				this.logFile,
				currentContent + entriesToFlush.join("\n") + "\n",
			);
		} catch (e) {
			console.error("Failed to flush log buffer to file:", e);
			this.logBuffer.unshift(...entriesToFlush);
		} finally {
			this.isWriting = false;
		}
	}

	private async cleanupOldLogs(
		maxAgeDays = 7,
		maxFileCount?: number,
	): Promise<void> {
		const folder = this.vault.getAbstractFileByPath(this.logDir);
		if (!(folder instanceof TFolder)) return;

		const now = Date.now();
		const cutoffTime = now - maxAgeDays * 24 * 60 * 60 * 1000;
		const logFiles: { file: TFile; mtime: number }[] = [];

		for (const child of folder.children) {
			if (
				child instanceof TFile &&
				child.name.startsWith("koreader-importer_") &&
				child.extension === "md"
			) {
				try {
					const stat = await this.vault.adapter.stat(child.path);
					if (stat?.mtime) {
						logFiles.push({ file: child, mtime: stat.mtime });
					}
				} catch (e) {
					/* ignore stat error for individual file */
				}
			}
		}
		logFiles.sort((a, b) => a.mtime - b.mtime); // Oldest first

		let filesToDeletePaths: string[] = [];

		// Mark files older than maxAgeDays for deletion
		for (const lf of logFiles) {
			if (lf.mtime < cutoffTime) {
				filesToDeletePaths.push(lf.file.path);
			}
		}

		// If maxFileCount is set and we still have too many files (after age-based pruning)
		if (
			maxFileCount &&
			logFiles.length - filesToDeletePaths.length > maxFileCount
		) {
			const numberToPruneByCount =
				logFiles.length - filesToDeletePaths.length - maxFileCount;
			let prunedByCount = 0;
			for (const lf of logFiles) {
				// Iterate oldest first
				if (prunedByCount >= numberToPruneByCount) break;
				if (!filesToDeletePaths.includes(lf.file.path)) {
					// If not already marked for deletion
					filesToDeletePaths.push(lf.file.path);
					prunedByCount++;
				}
			}
		}

		filesToDeletePaths = Array.from(new Set(filesToDeletePaths)); // Ensure uniqueness

		let deletedCount = 0;
		for (const filePath of filesToDeletePaths) {
			const fileInstance = this.vault.getAbstractFileByPath(filePath);
			if (fileInstance instanceof TFile) {
				try {
					await this.vault.delete(fileInstance);
					deletedCount++;
				} catch (error) {
					console.error(
						`Failed to delete old log file ${fileInstance.name}:`,
						error,
					);
				}
			}
		}

		if (deletedCount > 0) {
			console.log(
				`Cleaned up ${deletedCount} old log files from ${this.logDir}.`,
			);
		}
	}
}

let logManager: LogManager | null = null;

export async function initLogging(
	vault: Vault,
	logFolderPath: string,
	cleanupOptions?: {
		enabled: boolean;
		maxAgeDays?: number;
		maxFiles?: number;
	},
): Promise<string> {
	if (!isDebugFileLoggingEnabled) {
		if (logManager) await closeLogging();
		return "";
	}
	if (logManager?.logFile) {
		return logManager.logDir;
	}

	logManager = new LogManager(vault, logFolderPath);
	try {
		await logManager.initialize(cleanupOptions);

		if (logManager.logFile) {
			console.log(
				"File logging successfully initialized to:",
				logManager.logFile.path,
			);
			await logManager.write(
				`File logging system started. Console Log Level: ${
					DebugLevel[currentConsoleLogLevel]
				}. File log captures all severities.`,
				"INFO",
			);
		} else {
			console.warn("File logging could not be started.");
			logManager = null; // disable
		}
	} catch (error) {
		console.error(
			"Critical error during LogManager initialization, file logging disabled:",
			error,
		);
		logManager = null;
	}
	return logManager?.logDir || "";
}

export async function closeLogging(): Promise<void> {
	if (logManager) {
		const lm = logManager; // Capture instance
		logManager = null; // Nullify global first to prevent race conditions on re-entry
		if (lm.flushTimer) clearTimeout(lm.flushTimer);
		await lm.flush();
	}
}
