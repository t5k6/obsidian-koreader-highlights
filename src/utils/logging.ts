import { normalizePath, TFile, TFolder, type Vault } from "obsidian";
import pako from "pako";

/* ---------------------------------------------------------------- *\
 |  HELPERS                                                          |
\* ---------------------------------------------------------------- */

function formatArgs(args: any[]): string {
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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dayStamp = () => new Date().toISOString().slice(0, 10);

async function mkdirp(vault: Vault, dir: string) {
	const normalizedDir = normalizePath(dir);
	if (await vault.adapter.exists(normalizedDir)) return;

	const parts = normalizedDir.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		try {
			// eslint-disable-next-line no-await-in-loop
			await vault.createFolder(current);
		} catch (e: any) {
			// Ignore errors if folder was created in parallel
			if (e?.message?.includes("Folder already exists")) continue;
			throw e;
		}
	}
}

/* ---------------------------------------------------------------- *\
 |  QUEUE & SINKS                                                    |
\* ---------------------------------------------------------------- */

type QueueItem = { lvl: string; msg: string; ts: number };

class BufferedQueue {
	private buf: QueueItem[] = [];
	private sizeBytes = 0;
	private drainTimer: NodeJS.Timeout | undefined;

	constructor(
		private maxItems: number,
		private maxBytes: number,
		private delay: number,
		private drainCb: (batch: QueueItem[]) => Promise<void>,
	) {}

	enqueue(item: QueueItem) {
		this.buf.push(item);
		this.sizeBytes += item.msg.length + 24; // Approximation of memory usage
		if (this.buf.length >= this.maxItems || this.sizeBytes >= this.maxBytes) {
			this.flushNow();
		} else if (!this.drainTimer) {
			this.drainTimer = setTimeout(() => this.flushNow(), this.delay);
		}
	}

	drainAll(): QueueItem[] {
		const batch = this.buf;
		this.buf = [];
		this.sizeBytes = 0;
		return batch;
	}

	private flushNow() {
		if (this.drainTimer) {
			clearTimeout(this.drainTimer);
			this.drainTimer = undefined;
		}
		const batch = this.drainAll();
		if (batch.length) void this.drainCb(batch);
	}
}

class FileSink {
	private curFile: TFile | null = null;
	private curSize = 0;
	private curDate = "";
	private rotating = false;
	private readonly MAX_LOG_SIZE = 2 * 1024 * 1024; // 2 MB
	private readonly MAX_LOG_FILES = 10;

	constructor(
		private vault: Vault,
		private dir: string,
	) {
		void this.rotate();
	}

	async write(batch: QueueItem[]) {
		if (this.rotating) await delay(100); // Wait for rotation to complete
		if (!this.curFile) return;

		const text = `${batch
			.map((i) => `[${new Date(i.ts).toISOString()}] [${i.lvl}] ${i.msg}`)
			.join("\n")}\n`;
		try {
			await this.vault.adapter.append(this.curFile.path, text);
			this.curSize += text.length;

			if (this.curSize > this.MAX_LOG_SIZE || dayStamp() !== this.curDate) {
				void this.rotate();
			}
		} catch (error) {
			console.error("KOReader Logger: Failed to write to log file.", error);
		}
	}

	private async rotate() {
		this.rotating = true;
		try {
			await mkdirp(this.vault, this.dir);
			const date = dayStamp();
			const filePath = normalizePath(
				`${this.dir}/log_${date}_${Date.now()}.md`,
			);
			this.curFile = await this.vault.create(
				filePath,
				`# KOReader Importer Log\nLog created: ${new Date().toISOString()}\n\n`,
			);
			this.curSize = 0;
			this.curDate = date;
			void this.cleanup(); // Fire-and-forget cleanup
		} catch (error) {
			console.error("KOReader Logger: Failed to rotate log file.", error);
			this.curFile = null; // Stop logging if rotation fails
		} finally {
			this.rotating = false;
		}
	}

	private async cleanup() {
		const folder = this.vault.getAbstractFileByPath(this.dir);
		if (!(folder instanceof TFolder)) return;

		const files = folder.children
			.filter(
				(f): f is TFile =>
					f instanceof TFile &&
					f.name.startsWith("log_") &&
					f.path !== this.curFile?.path,
			)
			.sort((a, b) => b.stat.mtime - a.stat.mtime); // Newest first

		// Gzip old .md files
		for (const file of files) {
			if (file.extension === "md") {
				try {
					// eslint-disable-next-line no-await-in-loop
					const content = await this.vault.adapter.read(file.path);
					const compressed = pako.gzip(content);
					// eslint-disable-next-line no-await-in-loop
					await this.vault.adapter.writeBinary(`${file.path}.gz`, compressed);
					// eslint-disable-next-line no-await-in-loop
					await this.vault.adapter.remove(file.path);
				} catch (e) {
					console.error(`KOReader Logger: Failed to compress ${file.path}`, e);
				}
			}
		}

		// Delete oldest files if count exceeds max
		const allLogs = folder.children
			.filter(
				(f): f is TFile =>
					f instanceof TFile &&
					f.name.startsWith("log_") &&
					f.path !== this.curFile?.path,
			)
			.sort((a, b) => a.stat.mtime - b.stat.mtime); // Oldest first

		if (allLogs.length > this.MAX_LOG_FILES) {
			const toDelete = allLogs.slice(0, allLogs.length - this.MAX_LOG_FILES);
			for (const file of toDelete) {
				// eslint-disable-next-line no-await-in-loop
				await this.vault.adapter.remove(file.path);
			}
		}
	}

	async dispose() {
		// Nothing to do here, flush is handled by the Logger class
	}
}

/* ---------------------------------------------------------------- *\
 |  MAIN SINGLETON                                                   |
\* ---------------------------------------------------------------- */

export enum DebugLevel {
	NONE = 3,
	ERROR = 2,
	WARN = 1,
	INFO = 0,
}

class Logger {
	private level: DebugLevel = DebugLevel.NONE;
	private fileSink: FileSink | undefined;
	private q: BufferedQueue;

	constructor() {
		this.q = new BufferedQueue(500, 64 * 1024, 800, (batch) =>
			this.flush(batch),
		);
	}

	public setLevel(level: DebugLevel) {
		this.level = level;
		this.info(`Console log level set to ${DebugLevel[level]}`);
	}

	public enableFileSink(enable: boolean, vault?: Vault, dir = "KOReader/logs") {
		if (enable && !this.fileSink && vault) {
			this.fileSink = new FileSink(vault, dir);
			this.info(`File logging enabled to directory: ${dir}`);
		} else if (!enable && this.fileSink) {
			const sink = this.fileSink;
			this.fileSink = undefined;
			this.info("File logging disabled.");
			// Ensure final flush before disposal
			this.flush(this.q.drainAll()).then(() => sink.dispose());
		}
	}

	public info(...args: any[]) {
		if (this.level <= DebugLevel.INFO) this.emit("INFO", args);
	}
	public warn(...args: any[]) {
		if (this.level <= DebugLevel.WARN) this.emit("WARN", args);
	}
	public error(...args: any[]) {
		if (this.level <= DebugLevel.ERROR) this.emit("ERROR", args);
	}

	private emit(lvl: "INFO" | "WARN" | "ERROR", args: any[]) {
		const msg = formatArgs(args);
		if (this.level <= DebugLevel.INFO && lvl === "INFO") console.log(msg);
		if (this.level <= DebugLevel.WARN && lvl === "WARN") console.warn(msg);
		if (this.level <= DebugLevel.ERROR && lvl === "ERROR") console.error(msg);

		if (this.fileSink) {
			this.q.enqueue({ lvl, msg, ts: Date.now() });
			if (lvl === "ERROR") void this.flush(this.q.drainAll());
		}
	}

	private async flush(batch: QueueItem[]) {
		if (!batch?.length || !this.fileSink) return;
		await this.fileSink.write(batch);
	}

	async dispose() {
		const finalBatch = this.q.drainAll();
		await this.flush(finalBatch);
		await this.fileSink?.dispose();
		this.fileSink = undefined;
	}
}

export const logger = new Logger();

// Legacy control functions
export const setDebugLevel = logger.setLevel.bind(logger);
export function setDebugMode(enable: boolean, vault?: Vault) {
	logger.enableFileSink(enable, vault);
}

export const closeLogging = logger.dispose.bind(logger);
