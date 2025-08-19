import { debounce, normalizePath } from "obsidian";
import { isErr } from "src/lib/core/result";
import { formatDateForDailyNote } from "src/lib/formatting/dateUtils";
import type { FileSystemService } from "./FileSystemService";

const datestamp = () => formatDateForDailyNote();

async function ensureDir(fs: FileSystemService, dir: string) {
	// Best-effort ensure via FileSystemService
	const res = await fs.ensureVaultFolder(dir);
	if (isErr(res)) {
		// Swallow: logging is best-effort and should not throw
		return;
	}
}

export class AsyncFileSink {
	private curDate = "";
	private curFilePath: string | null = null;

	private buf: string[] = [];
	private dropped = 0;

	private readonly maxBufferLines = 2000; // cap memory
	private readonly retentionFiles: number;
	private readonly dir: string;
	private readonly fs: FileSystemService;

	private flushInFlight: Promise<void> | null = null;
	private readonly flushDebounced: () => void;

	constructor(
		fs: FileSystemService,
		dir: string,
		retentionFiles = 10,
		flushDelayMs = 800,
	) {
		this.fs = fs;
		this.dir = dir;
		this.retentionFiles = retentionFiles;
		this.flushDebounced = debounce(
			() => void this.flushNow(),
			flushDelayMs,
			false,
		);
		// Fire-and-forget: ensure folder exists and apply retention once
		void this.init();
	}

	async init(): Promise<void> {
		await ensureDir(this.fs, this.dir);
		await this.ensureFileForToday();
		await this.enforceRetention();
	}

	// Dumb sink: append pre-formatted line with buffering and debounce
	public append(line: string): void {
		this.buf.push(line);
		if (this.buf.length > this.maxBufferLines) {
			const overflow = this.buf.length - this.maxBufferLines;
			this.buf = this.buf.slice(-this.maxBufferLines);
			this.dropped += overflow;
		}
		this.flushDebounced();
	}

	// Allow callers to force flush (e.g., on errors) per higher-level policy
	public async flush(): Promise<void> {
		await this.flushNow();
	}

	async dispose(): Promise<void> {
		// Cancel scheduled debounce and flush whatever remains
		(this.flushDebounced as any)?.cancel?.();
		await this.flushNow();
	}

	private async ensureFileForToday(): Promise<void> {
		const today = datestamp();
		if (this.curDate === today && this.curFilePath) return;

		this.curDate = today;
		this.curFilePath = normalizePath(`${this.dir}/log_${today}.md`);

		// Idempotent file ensure with a simple header (if creating)
		const existsRes = await this.fs.vaultExists(this.curFilePath);
		const exists = !isErr(existsRes) && Boolean(existsRes.value);
		if (!exists) {
			await ensureDir(this.fs, this.dir);
			const r = await this.fs.writeVaultTextAtomic(
				this.curFilePath,
				`# KOReader Importer Log (${today})\n\n`,
			);
			if (isErr(r)) {
				// Name collision or other error — bail out of file logging for this session
				this.curFilePath = null;
			}
		}
	}

	private async enforceRetention(): Promise<void> {
		const listed = await this.fs.listVaultDir(this.dir);
		if (isErr(listed)) return; // best-effort

		// Only keep markdown files matching our naming pattern; sort by filename (YYYY-MM-DD)
		const files = listed.value.files
			.filter((p) => /\/log_\d{4}-\d{2}-\d{2}\.md$/.test(normalizePath(p)))
			.sort((a, b) => a.localeCompare(b));

		while (files.length > this.retentionFiles) {
			const fileToDelete = files.shift()!;
			const r = await this.fs.removeVaultPath(fileToDelete);
			// best-effort: ignore errors
			void r;
		}
	}

	private async flushNow(): Promise<void> {
		if (this.buf.length === 0) return this.flushInFlight ?? Promise.resolve();
		// Serialize flushes
		if (this.flushInFlight) {
			await this.flushInFlight;
			if (this.buf.length === 0) return;
		}

		// Snapshot current buffer and reset
		const droppedNote =
			this.dropped > 0
				? `\n… dropped ${this.dropped} log line(s) due to buffer limit\n`
				: "";
		const toWrite = this.buf.join("\n") + "\n" + droppedNote;
		this.buf = [];
		this.dropped = 0;

		this.flushInFlight = (async () => {
			try {
				await this.ensureFileForToday();
				if (!this.curFilePath) return;
				await this.fs.appendVaultText(this.curFilePath, toWrite);
			} catch {
				// swallow; file logging is best-effort
			} finally {
				this.flushInFlight = null;
			}
		})();

		await this.flushInFlight;
	}
}
