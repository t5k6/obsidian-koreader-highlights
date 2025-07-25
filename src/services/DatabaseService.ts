/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { normalizePath } from "obsidian";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { SQLITE_WASM } from "src/binaries/sql-wasm-base64";
import type { Disposable } from "src/core/DIContainer";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { debounce } from "src/utils/debounce";
import { isFileMissing, writeFileEnsured } from "src/utils/fileUtils";
import {
	levenshteinDistance,
	normalizeFileNamePiece,
} from "src/utils/formatUtils";
import { createLogger, logger } from "src/utils/logging";
import { LruCache } from "src/utils/LruCache";
import type {
	BookStatistics,
	DocProps,
	KoreaderHighlightImporterSettings,
	LuaMetadata,
	PageStatData,
	ReadingStatus,
} from "../types";

/* ------------------------------------------------------------------ */
/*                      SHARED HELPER CLASSES                         */
/* ------------------------------------------------------------------ */

type SQLDatabase = InstanceType<
	Awaited<ReturnType<typeof initSqlJs>>["Database"]
>;

interface DebouncedFunction<T extends (...args: any[]) => any> {
	(...args: Parameters<T>): void;
	cancel(): void;
}

const INDEX_DB_SCHEMA = `
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS book(
  key        TEXT PRIMARY KEY,
  id         INTEGER,
  title      TEXT NOT NULL,
  authors    TEXT,
  vault_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_book_path ON book(vault_path);
`;

const log = createLogger("DatabaseService");

/* ------------------------------------------------------------------ */
/*                            MAIN CLASS                              */
/* ------------------------------------------------------------------ */

export class DatabaseService implements Disposable {
	/* ---------------- sql.js instance (static) -------------------- */
	private static sqlJsInstance: SqlJsStatic | null = null;
	private static sqlJsInit: Promise<SqlJsStatic> | null = null;
	private static async getSqlJs(): Promise<SqlJsStatic> {
		if (DatabaseService.sqlJsInstance) return DatabaseService.sqlJsInstance;
		if (DatabaseService.sqlJsInit) return DatabaseService.sqlJsInit;

		const binary = Buffer.from(SQLITE_WASM, "base64").buffer;
		DatabaseService.sqlJsInit = initSqlJs({ wasmBinary: binary })
			.then((sql) => {
				DatabaseService.sqlJsInstance = sql;
				DatabaseService.sqlJsInit = null;
				return sql;
			})
			.catch((err) => {
				DatabaseService.sqlJsInit = null;
				throw err;
			});
		return DatabaseService.sqlJsInit;
	}

	/* -------------------  object life-cycle ----------------------- */
	private db: SQLDatabase | null = null; // statistics.sqlite3
	private idxDb: SQLDatabase | null = null; // highlight_index.sqlite
	private initializing: Promise<void> | null = null;
	private idxInitializing: Promise<void> | null = null;

	private idxPath: string; // cached path for persistence
	private currentMountPoint: string | null;

	/* ---------------- prepared statements & caches ---------------- */
	// simple in-memory LRU (only last 200 bookKeys) to save IPC to sql.js
	private pathCache = new LruCache<string, string[]>(200);

	private persistIndexDebounced: DebouncedFunction<() => Promise<void>>;

	constructor(private plugin: KoreaderImporterPlugin) {
		this.currentMountPoint = plugin.settings.koreaderMountPoint;
		this.idxPath = normalizePath(
			path.join(
				this.plugin.app.vault.configDir,
				"plugins",
				"koreader-importer",
				"highlight_index.sqlite",
			),
		);

		this.persistIndexDebounced = debounce(() => this.persistIndex(), 2_500);
	}

	/* ------------------------------------------------------------------ */
	/*                       ─── PUBLIC  API ───                          */
	/* ------------------------------------------------------------------ */

	/* 1️⃣ DocProps ➜ deterministic key */
	public bookKeyFromDocProps(props: DocProps): string {
		const authorSlug = normalizeFileNamePiece(props.authors).toLowerCase();
		const titleSlug = normalizeFileNamePiece(props.title).toLowerCase();
		return `${authorSlug}::${titleSlug}`;
	}

	/* 2️⃣ Fast duplicate detection (book-level) */
	public async findExistingBookFiles(bookKey: string): Promise<string[]> {
		const cached = this.pathCache.get(bookKey);
		if (cached) return cached;

		await this.ensureIndexReady();
		if (!this.idxDb) return [];

		const stmt = this.idxDb.prepare(
			"SELECT vault_path FROM book WHERE key = ? AND vault_path IS NOT NULL",
		);

		const paths: string[] = [];
		try {
			stmt.bind([bookKey]);
			while (stmt.step()) {
				const row = stmt.getAsObject();
				if (row.vault_path) paths.push(row.vault_path as string);
			}
		} finally {
			stmt.free();
		}

		this.pathCache.set(bookKey, paths);
		return paths;
	}

	/* ------------------------------------------------------------------ */
	/*                 ───    STATISTICS (device)   ───                   */
	/* ------------------------------------------------------------------ */

	public async findBookStatistics(
		title: string,
		authors: string,
		md5?: string,
	): Promise<LuaMetadata["statistics"] | null> {
		const mountPoint = this.plugin.settings.koreaderMountPoint;
		if (!mountPoint) {
			logger.warn(
				"DatabaseService: KOReader mount point not configured – skipping stats.",
			);
			return null;
		}

		let db: SQLDatabase | null = null;
		try {
			const deviceRoot = (await this.findDeviceRoot(mountPoint)) ?? mountPoint;
			const filePath = path.join(
				deviceRoot,
				".adds",
				"koreader",
				"settings",
				"statistics.sqlite3",
			);

			const SQL = await DatabaseService.getSqlJs();
			const fileBuf = await fsp.readFile(filePath);
			db = new SQL.Database(fileBuf);

			// ── Tiered lookup --------------------------------------------------
			let bookRow: BookStatistics | null = null;

			// 1️⃣ MD5 + title (perfect match)
			if (md5)
				bookRow = this.queryFirstRow<BookStatistics>(
					db,
					"SELECT * FROM book WHERE md5 = ? AND title = ?",
					[md5, title],
				);

			// 2️⃣ MD5 only (author disambiguation)
			if (!bookRow && md5) {
				const candidates = this.queryAllRows<BookStatistics>(
					db,
					"SELECT * FROM book WHERE md5 = ?",
					[md5],
				);
				if (candidates.length === 1) {
					bookRow = candidates[0];
				} else if (candidates.length > 1) {
					let best: BookStatistics | null = null;
					let minDistance = Infinity;
					for (const c of candidates) {
						const d = levenshteinDistance(authors, c.authors ?? "");
						if (d < minDistance) {
							minDistance = d;
							best = c;
						}
					}
					bookRow = best;
				}
			}

			// 3️⃣ Fallback: author + title
			if (!bookRow) {
				bookRow = this.queryFirstRow<BookStatistics>(
					db,
					"SELECT * FROM book WHERE authors = ? AND title = ?",
					[authors, title],
				);
			}

			if (!bookRow) return null;

			const sessions = this.queryAllRows<PageStatData>(
				db,
				"SELECT * FROM page_stat_data WHERE id_book = ? ORDER BY start_time",
				[bookRow.id],
			);

			return {
				book: bookRow,
				readingSessions: sessions,
				derived: this.calculateDerivedStatistics(bookRow, sessions),
			};
		} catch (error: any) {
			if (isFileMissing(error)) {
				logger.info(
					"DatabaseService: Statistics DB not found (normal on indirect device sync).",
				);
				return null;
			}
			logger.error(
				`DatabaseService: Failed to get book statistics for "${title}"`,
				error,
			);
			return null;
		} finally {
			db?.close();
		}
	}

	/** For merge feature – insert / update */
	public async upsertBook(
		id: number | null,
		key: string,
		title: string,
		authors: string,
		vaultPath?: string,
	): Promise<void> {
		await this.ensureIndexReady();
		this.idxDb!.run(
			`
				INSERT INTO book(key,id,title,authors,vault_path)
				VALUES(?,?,?,?,?)
				ON CONFLICT(key) DO UPDATE SET
				  id         = COALESCE(excluded.id, book.id),
				  title      = excluded.title,
				  authors    = excluded.authors,
				  vault_path = COALESCE(excluded.vault_path, book.vault_path);
			`,
			[key, id, title, authors, vaultPath ?? null],
		);
		this.pathCache.delete(key);
		this.persistIndexDebounced();
	}

	/* -------------------- settings hot-reload ---------------------- */
	public setSettings(s: Readonly<KoreaderHighlightImporterSettings>) {
		if (s.koreaderMountPoint !== this.currentMountPoint) {
			this.db?.close(); // will be reopened lazily
			this.db = null;
			this.currentMountPoint = s.koreaderMountPoint;
		}
	}

	/* ------------------------------------------------------------------ */
	/*                  ─── PRIVATE HELPERS (sql) ───                     */
	/* ------------------------------------------------------------------ */

	private queryFirstRow<T = Record<string, unknown>>(
		db: SQLDatabase,
		sql: string,
		params: any[] = [],
	): T | null {
		const stmt = db.prepare(sql);
		try {
			stmt.bind(params);
			return stmt.step() ? (stmt.getAsObject() as unknown as T) : null;
		} finally {
			stmt.free();
		}
	}

	private queryAllRows<T = Record<string, unknown>>(
		db: SQLDatabase,
		sql: string,
		params: any[] = [],
	): T[] {
		const stmt = db.prepare(sql);
		const out: T[] = [];
		try {
			stmt.bind(params);
			while (stmt.step()) out.push(stmt.getAsObject() as unknown as T);
			return out;
		} finally {
			stmt.free();
		}
	}

	private calculateDerivedStatistics(
		book: BookStatistics,
		sessions: PageStatData[],
	) {
		const totalReadPages = book.total_read_pages ?? 0;
		const pages = book.pages ?? 0;

		const percentComplete =
			pages > 0 ? Math.round((totalReadPages / pages) * 100) : 0;
		const averageTimePerPage =
			totalReadPages && book.total_read_time
				? book.total_read_time / 60 / totalReadPages
				: 0;

		const readingStatus: ReadingStatus =
			sessions.length === 0
				? "unstarted"
				: pages > 0 && totalReadPages >= pages
					? "completed"
					: "ongoing";

		return {
			percentComplete,
			averageTimePerPage,
			firstReadDate: sessions[0]
				? new Date(sessions[0].start_time * 1000)
				: null,
			lastReadDate: new Date(book.last_open * 1000),
			readingStatus,
		};
	}

	/* ------------------------------------------------------------------ */
	/*             ───   CONNECTION BOOTSTRAP / TEARDOWN  ───             */
	/* ------------------------------------------------------------------ */

	private async ensureIndexReady(): Promise<void> {
		if (this.idxDb) return;
		if (this.idxInitializing) return this.idxInitializing;

		this.idxInitializing = (async () => {
			await this.openIndexDatabase();
			this.idxInitializing = null;
		})();
		return this.idxInitializing;
	}

	private async openIndexDatabase(): Promise<void> {
		const SQL = await DatabaseService.getSqlJs();
		let bytes: Uint8Array | null = null;

		try {
			bytes = await fsp.readFile(this.idxPath);
			logger.info(`DatabaseService: Opening index DB: ${this.idxPath}`);
			this.idxDb = new SQL.Database(bytes);
		} catch (e: any) {
			if (e.code !== "ENOENT") throw e;
			logger.info("DatabaseService: No index DB yet, creating fresh one");
			this.idxDb = new SQL.Database();
			this.idxDb.run(INDEX_DB_SCHEMA);
			await this.persistIndex(); // initial disk write
		}
	}

	/* ------------------  persistence helpers ----------------------- */

	public async flushIndex(): Promise<void> {
		// Cancel any pending debounced save
		this.persistIndexDebounced.cancel();
		// Then persist immediately
		await this.persistIndex();
	}

	private async persistIndex() {
		if (!this.idxDb) return;
		logger.info("DatabaseService: Persisting index database to disk...");
		try {
			const data = this.idxDb.export();
			await writeFileEnsured(this.idxPath, data);
			logger.info("DatabaseService: Index database persisted successfully.");
		} catch (error) {
			logger.error("DatabaseService: Failed to persist index database.", error);
		}
	}

	/* ------------------------------------------------------------------ */
	/*                             CLEAN-UP                               */
	/* ------------------------------------------------------------------ */

	public dispose() {
		// Cancel any pending debounced operations
		this.persistIndexDebounced.cancel();

		if (this.db) {
			this.db.close();
			this.db = null;
		}
		if (this.idxDb) {
			// final synchronous flush – happens on unload when UI is idle
			try {
				const data = this.idxDb.export();
				const dir = path.dirname(this.idxPath);
				// Ensure directory exists synchronously
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}
				fs.writeFileSync(this.idxPath, Buffer.from(data));
			} catch (e) {
				logger.error("DatabaseService: Unable to write index DB on dispose", e);
			}
			this.idxDb.close();
			this.idxDb = null;
		}
	}

	/* ------------------------------------------------------------------ */
	/*                   ─── PRIVATE  utility methods ───                 */
	/* ------------------------------------------------------------------ */

	private async findDeviceRoot(startPath: string): Promise<string | null> {
		let p = path.resolve(startPath);
		for (let i = 0; i < 10; i++) {
			try {
				await fsp.access(path.join(p, ".adds"));
				return p;
			} catch {
				/* keep walking up */
			}
			const parent = path.dirname(p);
			if (parent === p) break;
			p = parent;
		}
		return null;
	}
}
