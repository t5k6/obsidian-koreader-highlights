import type { Vault } from "obsidian";
import { DEFAULT_LOGS_FOLDER } from "src/constants";
import type {
	Disposable,
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "../types";
import { AsyncFileSink } from "./AsyncFileSink";
import type { FileSystemService } from "./FileSystemService";

// Pure formatting functions (functional core)
export const LogFormatters = {
	formatArgs(args: unknown[]): string {
		return args
			.map((x) => {
				if (x instanceof Error) return `${x.message}\n${x.stack ?? ""}`;
				if (typeof x === "object" && x !== null) {
					try {
						return JSON.stringify(x);
					} catch {
						return "[Unserializable Object]";
					}
				}
				return String(x);
			})
			.join(" ");
	},

	formatLogLine(
		timestamp: string,
		level: "INFO" | "WARN" | "ERROR",
		prefix: string,
		scope: string,
		message: string,
	): string {
		return `${timestamp} ${level.padEnd(5, " ")} ${prefix} [${scope}] ${message}`;
	},
};

/* ------------------------------------------------------------------ */
/*                      MAIN SERVICE CLASS                            */
/* ------------------------------------------------------------------ */

export enum LogLevel {
	NONE = 0,
	ERROR = 1,
	WARN = 2,
	INFO = 3,
}

export class LoggingService implements SettingsObserver, Disposable {
	private readonly LOG_PREFIX = "KOReader Importer:";
	private level: LogLevel = LogLevel.NONE;
	private sink: AsyncFileSink | null = null;
	private fs: FileSystemService | null = null;
	private lastLogDir: string | null = null;
	private currentSettings: KoreaderHighlightImporterSettings | null = null;

	constructor(private vault: Vault) {}

	public setFileSystem(fs: FileSystemService): void {
		this.fs = fs;
		// If settings already requested file logging, enable sink now.
		if (this.currentSettings?.logToFile && !this.sink) {
			const logDir = this.currentSettings.logsFolder || DEFAULT_LOGS_FOLDER;
			this.sink = new AsyncFileSink(this.fs, logDir, 10, 800);
			this.lastLogDir = logDir;
			this.info("LoggingService", "File logging enabled (late FS injection).");
		}
	}

	public onSettingsChanged(settings: KoreaderHighlightImporterSettings): void {
		this.currentSettings = settings;
		this.level = settings.logLevel;

		const shouldEnableSink = settings.logToFile;
		const logDir = settings.logsFolder || DEFAULT_LOGS_FOLDER;
		const dirChanged = this.lastLogDir !== logDir;

		if (shouldEnableSink) {
			if (!this.fs) {
				// Cannot enable file sink without FileSystemService
				this.level = Math.min(this.level, LogLevel.WARN);
				this.warn(
					"LoggingService",
					"File logging requested but FileSystemService not available yet. Will remain disabled.",
				);
				return;
			}
			if (!this.sink || dirChanged) {
				const old = this.sink;
				this.sink = new AsyncFileSink(this.fs, logDir, 10, 800);
				this.lastLogDir = logDir;
				if (old) void old.dispose();
				this.info("LoggingService", `File logging enabled at ${logDir}.`);
			}
		} else if (this.sink) {
			const old = this.sink;
			this.sink = null;
			this.lastLogDir = null;
			this.info("LoggingService", "File logging disabled.");
			void old.dispose();
		}
	}

	public info(scope: string, ...args: unknown[]): void {
		this.emit(LogLevel.INFO, "INFO", scope, args);
	}
	public warn(scope: string, ...args: unknown[]): void {
		this.emit(LogLevel.WARN, "WARN", scope, args);
	}
	public error(scope: string, ...args: unknown[]): void {
		this.emit(LogLevel.ERROR, "ERROR", scope, args);
	}

	public scoped(scope: string): {
		info: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
	} {
		return {
			info: (...args: unknown[]) => this.info(scope, ...args),
			warn: (...args: unknown[]) => this.warn(scope, ...args),
			error: (...args: unknown[]) => this.error(scope, ...args),
		};
	}

	public async dispose(): Promise<void> {
		await this.sink?.dispose();
	}

	private emit(
		level: LogLevel,
		tag: "INFO" | "WARN" | "ERROR",
		scope: string,
		args: unknown[],
	): void {
		if (this.level < level) return;

		const timestamp = new Date().toISOString();
		const msg = LogFormatters.formatArgs(args);
		const line = LogFormatters.formatLogLine(
			timestamp,
			tag,
			this.LOG_PREFIX,
			scope,
			msg,
		);

		// Side effects in the shell
		const consoleFn = this.getConsoleFn(level);
		consoleFn(line);
		this.sink?.append(line);

		// Flush immediately for errors to reduce loss risk
		if (level === LogLevel.ERROR) {
			void this.sink?.flush();
		}
	}

	private getConsoleFn(level: LogLevel): (message: string) => void {
		return level === LogLevel.ERROR
			? console.error
			: level === LogLevel.WARN
				? console.warn
				: console.log;
	}
}
