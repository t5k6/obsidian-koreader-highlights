/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { normalizePath } from "obsidian";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import type { Disposable } from "src/core/DIContainer";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { SQLITE_WASM } from "../binaries/sql-wasm-base64";
import type {
	BookStatistics,
	DocProps,
	KoreaderHighlightImporterSettings,
	LuaMetadata,
	PageStatData,
	ReadingStatus,
} from "../types";
import { debounce } from "../utils/debounce";
import {
	levenshteinDistance,
	normalizeFileNamePiece,
} from "../utils/formatUtils";
import { devError, devLog, devWarn } from "../utils/logging";

/* ------------------------------------------------------------------ */
/*                     ─── CONSTANTS & TYPES ───                      */
/* ------------------------------------------------------------------ */

type SQLDatabase = InstanceType<
	Awaited<ReturnType<typeof initSqlJs>>["Database"]
>;

// Define a type-safe debounced function interface
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

		const binary = Buffer.from(SQLITE_WASM, "base64");
		DatabaseService.sqlJsInit = initSqlJs({ wasmBinary: binary as Uint8Array })
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
	private pathCache = new Map<string, string[]>();

	// debounced export to persist index changes without blocking UI
	private persistIndexDebounced: DebouncedFunction<() => Promise<void>>;

	constructor(private plugin: KoreaderImporterPlugin) {
		this.currentMountPoint = plugin.settings.koboMountPoint;
		// Use normalizePath for cross-platform safety
		this.idxPath = normalizePath(
			path.join(
				// use the *data* dir so it survives plugin upgrades
				this.plugin.app.vault.configDir,
				"plugins",
				"koreader-importer",
				"highlight_index.sqlite",
			),
		);

		this.persistIndexDebounced = debounce(
			() => this.persistIndex(),
			2500,
		) as DebouncedFunction<() => Promise<void>>;
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
		// in-memory cache first
		const cached = this.pathCache.get(bookKey);
		if (cached) return cached;

		await this.ensureIndexReady();
		if (!this.idxDb) return [];

		// Prepare statement on-the-fly to avoid stale statement issues.
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
			// Always free the statement after use.
			stmt.free();
		}

		// tiny LRU of 200
		this.pathCache.set(bookKey, paths);
		if (this.pathCache.size > 200) {
			// delete first inserted (Map keeps insertion order)
			const firstKey = this.pathCache.keys().next().value;
			if (firstKey) this.pathCache.delete(firstKey);
		}
		return paths;
	}

	public async findBookStatistics(
		title: string,
		authors: string,
		md5?: string,
	): Promise<LuaMetadata["statistics"] | null> {
		const mountPoint = this.plugin.settings.koboMountPoint;
		if (!mountPoint) {
			devWarn("KOReader mount point not configured – skipping stats.");
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

			let bookRow: BookStatistics | null = null;

			// --- Tier 1: Perfect match (md5 + title) ---
			if (md5) {
				bookRow = this.queryBookRowByMd5AndTitle(db, md5, title);
				if (bookRow) {
					devLog(
						`Found perfect stats match for "${title}" using md5 and title.`,
					);
				}
			}

			// --- Tier 2: MD5 match with author disambiguation ---
			if (!bookRow && md5) {
				const candidates = this.queryBookRowsByMd5(db, md5);
				if (candidates.length === 1) {
					bookRow = candidates[0];
					devLog(`Found unique stats match for "${title}" using only md5.`);
				} else if (candidates.length > 1) {
					devLog(
						`Found ${candidates.length} books with same MD5. Disambiguating with author: "${authors}"`,
					);
					// Find the best match by comparing author strings
					let bestMatch: BookStatistics | null = null;
					let minDistance = Infinity;
					for (const candidate of candidates) {
						const distance = levenshteinDistance(
							authors,
							candidate.authors || "",
						);
						if (distance < minDistance) {
							minDistance = distance;
							bestMatch = candidate;
						}
					}
					bookRow = bestMatch;
					devLog(
						`Disambiguation selected: "${bookRow?.title}" (author distance: ${minDistance})`,
					);
				}
			}

			// --- Tier 3: Legacy fallback (authors + title) ---
			if (!bookRow) {
				bookRow = this.queryBookRowByAuthorsAndTitle(db, authors, title);
				if (bookRow)
					devLog(
						`Found stats match for "${title}" using author/title fallback.`,
					);
			}

			if (!bookRow) return null;

			const sessions = this.querySessions(db, bookRow.id);

			return {
				book: bookRow,
				readingSessions: sessions,
				derived: this.calculateDerivedStatistics(bookRow, sessions),
			};
		} catch (error) {
			// Check if the error is a "File Not Found" error.
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
				// This is an expected, non-critical situation.
				devLog(`Statistics database not found at the expected path. This is normal if not using a direct device mount. Proceeding without reading statistics.`);
				return null;
			}
			
			// For any other kind of error, log it as a problem.
			devError(`Failed to get book statistics for "${title}"`, error);
			return null;
		} finally {
			if (db) {
				db.close();
			}
		}
	}

	public async getBookStatistics(
		authors: string,
		title: string,
	): Promise<LuaMetadata["statistics"] | null> {
		const mountPoint = this.plugin.settings.koboMountPoint;
		if (!mountPoint) {
			devWarn("KOReader mount point not configured – skipping stats.");
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

			const bookRow = this.queryBookRow(db, authors, title);
			if (!bookRow) return null;

			const sessions = this.querySessions(db, bookRow.id);

			return {
				book: bookRow,
				readingSessions: sessions,
				derived: this.calculateDerivedStatistics(bookRow, sessions),
			};
		} catch (error) {
			devError(`Failed to get book statistics for "${title}"`, error);
			// The error is logged, and we return null to allow the import to continue.
			return null;
		} finally {
			// Ensure the connection is always closed.
			if (db) {
				db.close();
			}
		}
	}

	//  for merge feature we may add highlight insert later
	public async upsertBook(
		id: number | null,
		key: string,
		title: string,
		authors: string,
		vaultPath?: string,
	): Promise<void> {
		await this.ensureIndexReady();
		const sql = `
      INSERT INTO book(key,id,title,authors,vault_path)
      VALUES(?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET
        id         = COALESCE(excluded.id, book.id),
        title      = excluded.title,
        authors    = excluded.authors,
        vault_path = COALESCE(excluded.vault_path, book.vault_path);
    `;
		this.idxDb!.run(sql, [key, id, title, authors, vaultPath ?? null]);
		this.pathCache.delete(key); // bust cache
		this.persistIndexDebounced();
	}

	/* -------------------- settings hot-reload ----------------------- */
	public setSettings(s: Readonly<KoreaderHighlightImporterSettings>) {
		if (s.koboMountPoint !== this.currentMountPoint) {
			// statistics path changed → reopen
			if (this.db) {
				this.db.close();
				this.db = null;
			}
			this.currentMountPoint = s.koboMountPoint;
		}
	}

	/* ------------------------------------------------------------------ */
	/*                  ─── PRIVATE (stats helpers) ───                   */
	/* ------------------------------------------------------------------ */

	private calculateDerivedStatistics(
		book: BookStatistics,
		sessions: PageStatData[],
	) {
		const totalReadPages = book.total_read_pages ?? 0;
		const pages = book.pages ?? 0;

		const percentComplete =
			pages > 0 ? Math.round((totalReadPages / pages) * 100) : 0;
		const averageTimePerPage =
			totalReadPages > 0 && book.total_read_time > 0
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
			firstReadDate: sessions.length
				? new Date(sessions[0].start_time * 1000)
				: null,
			lastReadDate: new Date(book.last_open * 1000),
			readingStatus,
		};
	}

	private queryBookRow(
		db: SQLDatabase,
		authors: string,
		title: string,
	): BookStatistics | null {
		const stmt = db.prepare(
			"SELECT * FROM book WHERE authors = ? AND title = ?",
		);
		try {
			stmt.bind([authors, title]);
			if (stmt.step()) {
				const row = stmt.getAsObject();
				return row as unknown as BookStatistics;
			}
			return null;
		} finally {
			stmt.free();
		}
	}

	private queryBookRowByAuthorsAndTitle(
		db: SQLDatabase,
		authors: string,
		title: string,
	): BookStatistics | null {
		const stmt = db.prepare(
			"SELECT * FROM book WHERE authors = ? AND title = ?",
		);
		try {
			stmt.bind([authors, title]);
			if (stmt.step()) {
				const row = stmt.getAsObject();
				return row as unknown as BookStatistics;
			}
			return null;
		} finally {
			stmt.free();
		}
	}

	private queryBookRowByMd5AndTitle(
		db: SQLDatabase,
		md5: string,
		title: string,
	): BookStatistics | null {
		const stmt = db.prepare("SELECT * FROM book WHERE md5 = ? AND title = ?");
		try {
			stmt.bind([md5, title]);
			if (stmt.step()) {
				const row = stmt.getAsObject();
				return row as unknown as BookStatistics;
			}
			return null;
		} finally {
			stmt.free();
		}
	}

	private queryBookRowsByMd5(db: SQLDatabase, md5: string): BookStatistics[] {
		const stmt = db.prepare("SELECT * FROM book WHERE md5 = ?");
		const results: BookStatistics[] = [];
		try {
			stmt.bind([md5]);
			while (stmt.step()) {
				const row = stmt.getAsObject();
				results.push(row as unknown as BookStatistics);
			}
			return results;
		} finally {
			stmt.free();
		}
	}

	private querySessions(db: SQLDatabase, bookId: number): PageStatData[] {
		const stmt = db.prepare(
			"SELECT * FROM page_stat_data WHERE id_book = ? ORDER BY start_time",
		);
		try {
			stmt.bind([bookId]);
			const sessions: PageStatData[] = [];
			while (stmt.step()) {
				// Fix: Properly cast through unknown first
				const row = stmt.getAsObject();
				sessions.push(row as unknown as PageStatData);
			}
			return sessions;
		} finally {
			stmt.free();
		}
	}

	/* ------------------------------------------------------------------ */
	/*             ───   CONNECTION BOOTSTRAP / TEARDOWN  ───             */
	/* ------------------------------------------------------------------ */

	private async ensureReady(): Promise<void> {
		if (this.db) return;
		if (this.initializing) return this.initializing;

		this.initializing = (async () => {
			await this.openStatisticsDatabase();
			this.initializing = null;
		})();
		return this.initializing;
	}

	private async ensureIndexReady(): Promise<void> {
		if (this.idxDb) return;
		if (this.idxInitializing) return this.idxInitializing;

		this.idxInitializing = (async () => {
			await this.openIndexDatabase();
			this.idxInitializing = null;
		})();
		return this.idxInitializing;
	}

	private async openStatisticsDatabase(): Promise<void> {
		const mount = this.plugin.settings.koboMountPoint;
		if (!mount) throw new Error("Mount point not configured");

		const deviceRoot = (await this.findDeviceRoot(mount)) ?? mount;
		const filePath = path.join(
			deviceRoot,
			".adds",
			"koreader",
			"settings",
			"statistics.sqlite3",
		);

		devLog(`Opening statistics DB: ${filePath}`);
		const SQL = await DatabaseService.getSqlJs();
		const fileBuf = await fsp.readFile(filePath);
		this.db = new SQL.Database(fileBuf);
		this.db.exec("PRAGMA temp_store = MEMORY;");
	}

	private async openIndexDatabase(): Promise<void> {
		const SQL = await DatabaseService.getSqlJs();
		let bytes: Uint8Array | null = null;

		try {
			bytes = await fsp.readFile(this.idxPath);
			devLog(`Opening index DB: ${this.idxPath}`);
			this.idxDb = new SQL.Database(bytes);
		} catch (e: any) {
			if (e.code !== "ENOENT") throw e;
			devLog("No index DB yet, creating fresh one");
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
		devLog("Persisting index database to disk...");
		try {
			const data = this.idxDb.export();
			await fsp.mkdir(path.dirname(this.idxPath), { recursive: true });
			await fsp.writeFile(this.idxPath, Buffer.from(data));
			devLog("Index database persisted successfully.");
		} catch (error) {
			devError("Failed to persist index database.", error);
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
				devError("Unable to write index DB on dispose", e);
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
