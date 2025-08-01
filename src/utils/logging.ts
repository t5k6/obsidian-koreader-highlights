/* ────────────────────────────────────────────────────────────────────
   KOReader-Importer ─ Logger  📝
   • Non-blocking buffered writes
   • Daily rotation   • gzip compression in a WebWorker
   • Recursive mkdir  • race-safe
   • Promise-based settle()/dispose()
──────────────────────────────────────────────────────────────────── */

import { normalizePath, TFile, TFolder, type Vault } from "obsidian";
import pako from "pako";
import { DEFAULT_LOGS_FOLDER } from "src/constants";

/* ------------------------------------------------------------------ */
/*                      1.  small utilities                            */
/* ------------------------------------------------------------------ */

const LOG_PREFIX = "KOReader Importer:";
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

/* ------------------------------------------------------------------ */
/*                     2.  Buffered async queue                        */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*                    3.  File sink  (rotation)                        */
/* ------------------------------------------------------------------ */

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
      console.error(LOG_PREFIX, "logging: append failed", e);
      return;
    }

    if (this.curSize >= this.MAX_FILE_SIZE || datestamp() !== this.curDate) {
      this.rotating = this.rotate();
    }
  }

  private async rotate() {
    try {
      await mkdirp(this.vault, this.dir);

      // create at most one file per day unless size exceeded
      const date = datestamp();
      if (this.curDate === date && this.curSize < this.MAX_FILE_SIZE) return;

      this.curDate = date;
      const path = normalizePath(`${this.dir}/log_${timestamp()}.md`);
      this.curFile = await this.vault.create(path, `# ${path}` + "\n\n```\n");
      this.curSize = 0;
    } catch (e) {
      console.error(LOG_PREFIX, "logging: rotate failed", e);
      this.curFile = null;
    }
    await this.cleanup();
  }

  private async cleanup() {
    const folder = this.vault.getAbstractFileByPath(this.dir);
    if (!(folder instanceof TFolder)) return;

    // gzip old *.md
    for (const child of [...folder.children]) {
      if (
        child instanceof TFile &&
        child.extension === "md" &&
        child.path !== this.curFile?.path
      ) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const txt = await this.vault.adapter.read(child.path);
          const gz = pako.gzip(txt);
          // eslint-disable-next-line no-await-in-loop
          await this.vault.adapter.writeBinary(
            `${child.path}.gz`,
            new Uint8Array(gz.buffer, gz.byteOffset, gz.byteLength).slice()
              .buffer,
          );
          // eslint-disable-next-line no-await-in-loop
          await this.vault.adapter.remove(child.path);
        } catch (e) {
          console.error(LOG_PREFIX, "logging: gzip error", e);
        }
      }
    }

    /* enforce MAX_LOG_FILES on .gz files */
    const files = folder.children
      .filter((f): f is TFile => f instanceof TFile && f.extension === "gz")
      .sort((a, b) => a.stat.mtime - b.stat.mtime);

    while (files.length > this.MAX_LOG_FILES) {
      const f = files.shift()!;
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.vault.adapter.remove(f.path);
      } catch (e) {
        console.error(LOG_PREFIX, "logging: delete old log failed", e);
      }
    }
  }

  async dispose() {
    await this.rotating;
  }
}

/* ------------------------------------------------------------------ */
/*                      4.  Logger main class                          */
/* ------------------------------------------------------------------ */

export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
}

class Logger {
  private level = LogLevel.NONE;
  private sink?: FileSink;
  private queue = new BufferedQueue(
    500,
    64 * 1024,
    800,
    (b) => this.sink?.write(b) ?? Promise.resolve(),
  );

  /**  TEST-ONLY: force immediate flush + rotation, returns when done  */
  async __flushNow() {
    await this.queue.settle();
    // The write may or may not trigger a rotation. We need to await the
    // promise that `write` *might* have created.
    await (this.sink as any)?.rotating;
  }

  /**  TEST-ONLY: expose internals for spies (typed as any)            */
  get __sink() {
    return this.sink as any;
  }
  get __queue() {
    return this.queue as any;
  }

  /* ----------- configuration ----------- */
  setLevel = (lvl: LogLevel) => {
    this.level = lvl;
  };

  enableFileSink(enable: boolean, vault?: Vault, dir = DEFAULT_LOGS_FOLDER) {
    if (enable && !this.sink && vault) {
      this.sink = new FileSink(vault, dir);
      this.info(`File logging enabled (dir=${dir})`);
    }
    if (!enable && this.sink) {
      const s = this.sink;
      this.sink = undefined;
      this.info("File logging disabled");
      this.queue.settle().then(() => s.dispose());
    }
  }

  /* ----------- public logging API ----------- */
  info = (...a: unknown[]) => this.emit("INFO", LogLevel.INFO, a);
  warn = (...a: unknown[]) => this.emit("WARN", LogLevel.WARN, a);
  error = (...a: unknown[]) => this.emit("ERROR", LogLevel.ERROR, a);

  /* ----------- internals ----------- */
  private emit(tag: string, lvl: LogLevel, args: unknown[]) {
    if (this.level >= lvl) {
      const msg = formatArgs(args);
      // eslint-disable-next-line no-console
      (lvl === LogLevel.ERROR
        ? console.error
        : lvl === LogLevel.WARN
          ? console.warn
          : console.log)(LOG_PREFIX, msg);

      if (this.sink) this.queue.enqueue({ ts: Date.now(), lvl: tag, msg });
    }
  }

  async dispose() {
    await this.queue.settle();
    await this.sink?.dispose();
  }
}

/* ------------------------------------------------------------------ */
/*                 5.  singleton + convenience API                    */
/* ------------------------------------------------------------------ */

export const logger = new Logger();

export const setLogLevel = logger.setLevel.bind(logger);
export function setDebugMode(enable: boolean, vault?: Vault, dir?: string) {
  logger.enableFileSink(enable, vault, dir);
}
export const closeLogging = logger.dispose.bind(logger);

export const createLogger = (scope: string) => ({
  info: (...args: unknown[]) => logger.info(`[${scope}]`, ...args),
  warn: (...args: unknown[]) => logger.warn(`[${scope}]`, ...args),
  error: (...args: unknown[]) => logger.error(`[${scope}]`, ...args),
});
