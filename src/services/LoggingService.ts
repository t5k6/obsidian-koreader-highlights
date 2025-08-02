import { normalizePath, TFile, TFolder, type Vault } from "obsidian";
import pako from "pako";
import { DEFAULT_LOGS_FOLDER } from "src/constants";
import type {
	Disposable,
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "../types";

/* ------------------------------------------------------------------ */
/*                      1.  PRIVATE HELPERS                           */
/*   (These are implementation details of LoggingService)             */
/* ------------------------------------------------------------------ */

const datestamp = () => new Date().toISOString().slice(0, 10);
const timestamp = () =>
	new Date().toISOString().split(".")[0].replace(/[-:]/g, "");

function formatArgs(args: unknown[]): string {
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
}

async function mkdirp(vault: Vault, dir: string) {
	const parts = normalizePath(dir).split("/");
	let cursor = "";
	for (const p of parts) {
		cursor = cursor ? `${cursor}/${p}` : p;
		try {
			// eslint-disable-next-line no-await-in-loop
			await vault.createFolder(cursor);
		} catch (e: any) {
			if (!e?.message?.includes("exists")) throw e; // real error
		}
	}
}

type QueueItem = { ts: number; lvl: string; msg: string };

class BufferedQueue {
	private buf: QueueItem[] = [];
	private bytes = 0;
	private timer?: NodeJS.Timeout;
	private flushChain: Promise<void> = Promise.resolve();

	constructor(
		private readonly maxItems: number,
		private readonly maxBytes: number,
		private readonly delayMs: number,
		private readonly sink: (batch: QueueItem[]) => Promise<void>,
	) {}

	enqueue(item: QueueItem) {
		this.buf.push(item);
		this.bytes += item.msg.length + 32;

		if (this.buf.length >= this.maxItems || this.bytes >= this.maxBytes) {
			this.flushSoon(0);
		} else if (!this.timer) {
			this.flushSoon(this.delayMs);
		}
	}

	private flushSoon(ms: number) {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flushNow(), ms);
	}

	private flushNow(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.buf.length === 0) return this.flushChain;

		const batch = this.buf;
		this.buf = [];
		this.bytes = 0;

		this.flushChain = this.flushChain
			.then(() => this.sink(batch))
			.catch(() => {});
		return this.flushChain;
	}

	settle() {
		return this.flushNow();
	}
}

class FileSink {
	private curFile: TFile | null = null;
	private curSize = 0;
	private curDate = "";
	private rotating = Promise.resolve();

	private readonly MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
	private readonly MAX_LOG_FILES = 10;

	constructor(
		private vault: Vault,
		private dir: string,
	) {
		this.rotating = this.rotate();
	}

	async write(batch: QueueItem[]) {
		await this.rotating;
		if (!this.curFile) return;

		const text = `${batch
			.map(
				(i) =>
					`${new Date(i.ts).toISOString()} ${i.lvl.padEnd(5, " ")} ${i.msg}`,
			)
			.join("\n")}\n`;

		try {
			await this.vault.adapter.append(this.curFile.path, text);
			this.curSize += text.length;
		} catch (e) {
			console.error("KOReader Logger: append failed", e);
			return;
		}

		if (this.curSize >= this.MAX_FILE_SIZE || datestamp() !== this.curDate) {
			this.rotating = this.rotate();
		}
	}

	private async rotate() {
		try {
			await mkdirp(this.vault, this.dir);

			const date = datestamp();
			if (this.curDate === date && this.curSize < this.MAX_FILE_SIZE) return;

			this.curDate = date;
			const path = normalizePath(`${this.dir}/log_${timestamp()}.md`);
			this.curFile = await this.vault.create(path, `# ${path}` + "\n\n```\n");
			this.curSize = 0;
		} catch (e) {
			console.error("KOReader Logger: rotate failed", e);
			this.curFile = null;
		}
		await this.cleanup();
	}

	private async cleanup() {
		const folder = this.vault.getAbstractFileByPath(this.dir);
		if (!(folder instanceof TFolder)) return;

		for (const child of [...folder.children]) {
			if (
				child instanceof TFile &&
				child.extension === "md" &&
				child.path !== this.curFile?.path
			) {
				try {
					const txt = await this.vault.adapter.read(child.path);
					const gz = pako.gzip(txt);
					await this.vault.adapter.writeBinary(
						`${child.path}.gz`,
						new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength).slice()
							.buffer,
					);
					await this.vault.adapter.remove(child.path);
				} catch (e) {
					console.error("KOReader Logger: gzip error", e);
				}
			}
		}

		const files = folder.children
			.filter((f): f is TFile => f instanceof TFile && f.extension === "gz")
			.sort((a, b) => a.stat.mtime - b.stat.mtime);

		while (files.length > this.MAX_LOG_FILES) {
			const f = files.shift()!;
			try {
				await this.vault.adapter.remove(f.path);
			} catch (e) {
				console.error("KOReader Logger: delete old log failed", e);
			}
		}
	}

	async dispose() {
		await this.rotating;
	}
}

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
	private sink?: FileSink;
	private queue: BufferedQueue;

	constructor(private vault: Vault) {
		this.queue = new BufferedQueue(
			500,
			64 * 1024,
			800,
			(b) => this.sink?.write(b) ?? Promise.resolve(),
		);
	}

	public onSettingsChanged(settings: KoreaderHighlightImporterSettings): void {
		if (this.level !== settings.logLevel) {
			this.level = settings.logLevel;
		}

		const shouldEnableSink = settings.logToFile;
		const logDir = settings.logsFolder || DEFAULT_LOGS_FOLDER;

		// Case 1: Sink should be enabled, but isn't.
		if (shouldEnableSink && !this.sink) {
			this.sink = new FileSink(this.vault, logDir);
			this.info("LoggingService", "File logging enabled.");
		}
		// Case 2: Sink should be disabled, but is.
		else if (!shouldEnableSink && this.sink) {
			const oldSink = this.sink;
			this.sink = undefined;
			this.info("LoggingService", "File logging disabled.");
			this.queue.settle().then(() => oldSink.dispose());
		}
	}

	public info(scope: string, ...args: unknown[]): void {
		this.emit("INFO", LogLevel.INFO, `[${scope}]`, ...args);
	}
	public warn(scope: string, ...args: unknown[]): void {
		this.emit("WARN", LogLevel.WARN, `[${scope}]`, ...args);
	}
	public error(scope: string, ...args: unknown[]): void {
		this.emit("ERROR", LogLevel.ERROR, `[${scope}]`, ...args);
	}

	public async dispose(): Promise<void> {
		await this.queue.settle();
		await this.sink?.dispose();
	}

	private emit(tag: string, lvl: LogLevel, ...args: unknown[]): void {
		if (this.level >= lvl) {
			const msg = formatArgs(args);
			const consoleFn =
				lvl === LogLevel.ERROR
					? console.error
					: lvl === LogLevel.WARN
						? console.warn
						: console.log;

			consoleFn(this.LOG_PREFIX, msg);

			if (this.sink) {
				this.queue.enqueue({ ts: Date.now(), lvl: tag, msg });
			}
		}
	}
}
