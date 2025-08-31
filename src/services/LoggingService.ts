import type { Vault } from "obsidian";
import { DEFAULT_LOGS_FOLDER } from "src/constants";
import { safeStringify } from "src/lib/strings/stringUtils";
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
					return safeStringify(x);
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
		// Attempt to reconcile the sink state now that fs is available.
		this._updateSinkFromSettings();
	}

	public onSettingsChanged(settings: KoreaderHighlightImporterSettings): void {
		this.currentSettings = settings;
		this.level = settings.logLevel;
		// Reconcile the sink state with the new settings.
		this._updateSinkFromSettings();
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

	private async _disposeSink(): Promise<void> {
		if (!this.sink) return;

		const oldSink = this.sink;
		this.sink = null;
		this.lastLogDir = null;

		// Await disposal to ensure logs are flushed before we might re-enable
		await oldSink.dispose();
	}

	private _updateSinkFromSettings(): void {
		if (!this.currentSettings) return; // Not yet initialized

		const { logToFile, logsFolder } = this.currentSettings;
		const desiredLogDir = logsFolder || DEFAULT_LOGS_FOLDER;

		// Case 1: Logging is disabled, and we have an active sink.
		if (!logToFile && this.sink) {
			this.info("LoggingService", "File logging disabled by settings.");
			void this._disposeSink();
			return;
		}

		// Case 2: Logging is enabled.
		if (logToFile) {
			// Subcase 2a: Filesystem service isn't ready yet. Defer.
			if (!this.fs) {
				this.warn(
					"LoggingService",
					"File logging is enabled, but FileSystemService is not yet available. Sink creation deferred.",
				);
				return;
			}

			// Subcase 2b: Sink is already active and pointing to the correct directory. Do nothing.
			if (this.sink && this.lastLogDir === desiredLogDir) {
				return;
			}

			// Subcase 2c: Need to create a new sink (either it's the first time, or the directory changed).
			void (async () => {
				await this._disposeSink(); // Clean up old one if it exists

				this.sink = new AsyncFileSink(this.fs!, desiredLogDir, 10, 800);
				this.lastLogDir = desiredLogDir;
				this.info(
					"LoggingService",
					`File logging enabled at ${desiredLogDir}.`,
				);
			})();
		}
	}
}
