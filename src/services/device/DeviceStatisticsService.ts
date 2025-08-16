import path from "node:path";
import type { Database, SqlValue } from "sql.js";
import type { CacheManager } from "src/lib/cache/CacheManager";
import type { LruCache } from "src/lib/cache/LruCache";
import { AsyncLazy } from "src/lib/concurrency/asyncLazy";
import { ConcurrentDatabase } from "src/lib/concurrency/ConcurrentDatabase";
import { isErr } from "src/lib/core/result";
import type KoreaderImporterPlugin from "src/main";
import type {
	BookStatistics,
	Disposable,
	KoreaderHighlightImporterSettings,
	PageStatData,
	ReadingProgress,
	ReadingStatus,
	SettingsObserver,
} from "src/types";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { SqlJsManager } from "../SqlJsManager";

// --- Types ---
export interface BookStatisticsBundle {
	book: BookStatistics;
	readingSessions: PageStatData[];
	derived: ReadingProgress;
}

// --- Constants ---
const MAX_ROOT_SEARCH_DEPTH = 25;

const BOOK_COLUMNS =
	`id, md5, last_open, pages, total_read_time, total_read_pages, title, authors, series, language`
		.trim()
		.replace(/\s+/g, " ");

// Koreader DB sometimes shares the same md5 for different books
// So we need to check both md5 and title
const SQL_FIND_BOOK_BY_MD5 = /*sql*/ `SELECT ${BOOK_COLUMNS} FROM book WHERE md5 = ? AND title = ?`;
const SQL_FIND_BOOK_BY_AUTHOR_TITLE = /*sql*/ `SELECT ${BOOK_COLUMNS} FROM book WHERE authors = ? AND title = ?`;
const SQL_GET_SESSIONS = /*sql*/ `SELECT * FROM page_stat_data WHERE id_book = ? ORDER BY start_time`;

export class DeviceStatisticsService implements SettingsObserver, Disposable {
	private readonly log;
	private settings: KoreaderHighlightImporterSettings;
	private dbFilePath: string | null = null;
	private inMemoryDb: Database | null = null;
	private dbFileMtimeMs: number | null = null;
	private cdbLazy: AsyncLazy<ConcurrentDatabase | null>;

	private statsCache: LruCache<string, BookStatisticsBundle | null>;
	private deviceRootCache = new Map<string, string | null>();

	constructor(
		plugin: KoreaderImporterPlugin,
		private fsService: FileSystemService,
		private sqlJsManager: SqlJsManager,
		private loggingService: LoggingService,
		private cacheManager: CacheManager,
	) {
		this.settings = plugin.settings;
		this.statsCache = this.cacheManager.createLru<
			string,
			BookStatisticsBundle | null
		>("stats.derived", 100);
		this.log = this.loggingService.scoped("DeviceStatisticsService");
		this.cdbLazy = new AsyncLazy<ConcurrentDatabase | null>(async () => {
			const filePath = await this.resolveStatsDbPath();
			if (!filePath) {
				return null;
			}

			const bytesRes = await this.fsService.readBinaryAuto(filePath);
			if (isErr(bytesRes)) {
				this.log.error(
					`Failed to read KOReader stats DB bytes: ${filePath}`,
					(bytesRes as any).error ?? bytesRes,
				);
				return null;
			}
			const bytes = bytesRes.value;

			const SQL = await this.sqlJsManager.getSqlJs();
			const db = new SQL.Database(bytes); // strictly in-memory
			this.prepareSessionIndexes(db); // only in-memory changes

			this.inMemoryDb = db;
			this.dbFilePath = filePath;

			// capture mtime to support hot-reload if file changes
			const stRes = await this.fsService.getNodeStats(filePath);
			this.dbFileMtimeMs = isErr(stRes) ? null : stRes.value.mtimeMs;

			const cdb = new ConcurrentDatabase(async () => db);
			this.log.info(`Loaded KOReader stats DB into memory: ${filePath}`);
			return cdb;
		});
	}

	public async findBookStatistics(
		title: string,
		authors: string,
		md5?: string,
	): Promise<BookStatisticsBundle | null> {
		const db = await this.getConcurrentDb();
		if (!db) return null;

		return db.execute(async (database) => {
			const bookRow = this.findBook(database, title, authors, md5);
			if (!bookRow) return null;

			const cacheKey = `${bookRow.id}`;
			const cachedStats = this.statsCache.get(cacheKey);
			if (cachedStats) {
				this.log.info(`[CACHE HIT] Statistics for: "${title}"`);
				return cachedStats;
			}

			this.log.info(`Querying statistics for: "${title}"`);
			const sessions = this.queryAllRows<PageStatData>(
				database,
				SQL_GET_SESSIONS,
				[bookRow.id],
			);
			const result: BookStatisticsBundle = {
				book: bookRow,
				readingSessions: sessions,
				derived: this.calculateDerivedStatistics(bookRow, sessions),
			};

			this.statsCache.set(cacheKey, result);
			return result;
		});
	}

	private findBook(
		db: Database,
		title: string,
		authors: string,
		md5?: string,
	): BookStatistics | null {
		let row: BookStatistics | null = null;
		if (md5) {
			const r1 = this.queryFirstRow<any>(db, SQL_FIND_BOOK_BY_MD5, [
				md5,
				title,
			]);
			row = r1 ? this.mapBookRow(r1) : null;
		}
		if (!row) {
			const r2 = this.queryFirstRow<any>(db, SQL_FIND_BOOK_BY_AUTHOR_TITLE, [
				authors,
				title,
			]);
			row = r2 ? this.mapBookRow(r2) : null;
		}
		return row ?? null;
	}

	private prepareSessionIndexes(db: Database): void {
		// Build performance indexes only for the in-memory session
		try {
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_page_stat_book ON page_stat_data(id_book);",
			);
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_page_stat_start_time ON page_stat_data(start_time);",
			);
		} catch (e) {
			this.log.warn(
				"Failed to create session indexes (continuing without them).",
				e,
			);
		}
	}

	onSettingsChanged(newSettings: KoreaderHighlightImporterSettings): void {
		if (newSettings.koreaderScanPath !== this.settings.koreaderScanPath) {
			this.log.info("Scan path changed, resetting stats DB connection.");
			this.dispose();
		}
		this.settings = newSettings;
	}

	dispose(): void {
		// We never write back to device; just free memory
		try {
			this.inMemoryDb?.close?.();
		} catch {
			/* noop */
		}
		this.inMemoryDb = null;
		this.dbFilePath = null;
		this.dbFileMtimeMs = null;
		this.cdbLazy.reset();
		this.statsCache.clear();
	}

	/**
	 * Finds the KOReader device root by looking for .adds directory.
	 * Walks up the directory tree from the mount point.
	 * @param startPath - Starting directory path
	 * @returns Device root path or null if not found
	 */
	private async findDeviceRoot(mountPoint: string): Promise<string | null> {
		const cached = this.deviceRootCache.get(mountPoint);
		if (cached !== undefined) return cached;

		let p = path.resolve(mountPoint);
		for (let i = 0; i < MAX_ROOT_SEARCH_DEPTH; i++) {
			const stRes = await this.fsService.getNodeStats(path.join(p, ".adds"));
			if (!isErr(stRes)) {
				this.deviceRootCache.set(mountPoint, p);
				return p;
			}
			const parent = path.dirname(p);
			if (parent === p) break;
			p = parent;
		}
		this.deviceRootCache.set(mountPoint, null);
		return null;
	}

	/**
	 * Resolves the path to the statistics database.
	 * @returns Path to the statistics database or null if not found
	 */
	private async resolveStatsDbPath(): Promise<string | null> {
		const mountPoint = this.settings.koreaderScanPath;
		if (!mountPoint) {
			this.log.warn("Scan path not set, cannot resolve stats DB path.");
			return null;
		}

		const deviceRoot = await this.findDeviceRoot(mountPoint);
		if (!deviceRoot) {
			this.log.warn(`Could not find KOReader .adds in ${mountPoint}`);
			return null;
		}

		const filePath = path.join(
			deviceRoot,
			".adds/koreader/settings/statistics.sqlite3",
		);

		if (!(await this.fsService.nodeFileExists(filePath))) {
			this.log.warn(
				`Statistics DB not found or not accessible at ${filePath}.`,
			);
			return null;
		}

		return filePath;
	}

	/**
	 * Gets the concurrent database instance.
	 * @returns Concurrent database instance or null if not available
	 */
	private async refreshIfDeviceDbChanged(): Promise<void> {
		if (!this.dbFilePath) return;
		const stRes = await this.fsService.getNodeStats(this.dbFilePath);
		const mtime = isErr(stRes) ? null : stRes.value.mtimeMs;
		if (mtime && this.dbFileMtimeMs && mtime > this.dbFileMtimeMs) {
			this.log.info(
				"KOReader stats DB changed on device. Reloading in-memory DB.",
			);
			this.dispose(); // clears caches and closes in-memory DB
			// Recreate lazily on next getConcurrentDb()
		}
	}

	private async getConcurrentDb(): Promise<ConcurrentDatabase | null> {
		await this.refreshIfDeviceDbChanged().catch(() => {});
		return this.cdbLazy.get();
	}

	/**
	 * Executes a SQL query and returns the first row.
	 * @param db - SQLite database instance
	 * @param sql - SQL query string
	 * @param params - Query parameters
	 * @returns First row as object or null
	 */
	private queryFirstRow<R extends object>(
		db: Database,
		sql: string,
		params: SqlValue[] = [],
	): R | null {
		const stmt = db.prepare(sql);
		try {
			stmt.bind(params);
			return stmt.step() ? (stmt.getAsObject() as R) : null;
		} finally {
			stmt.free();
		}
	}

	/**
	 * Executes a SQL query and returns all matching rows.
	 * @param db - SQLite database instance
	 * @param sql - SQL query string
	 * @param params - Query parameters
	 * @returns Array of row objects
	 */
	private queryAllRows<R extends object>(
		db: Database,
		sql: string,
		params: SqlValue[] = [],
	): R[] {
		const out: R[] = [];
		const stmt = db.prepare(sql);
		try {
			stmt.bind(params);
			while (stmt.step()) out.push(stmt.getAsObject() as R);
			return out;
		} finally {
			stmt.free();
		}
	}

	private toNumber(value: unknown): number {
		const n =
			typeof value === "number"
				? value
				: typeof value === "string"
					? Number(value)
					: 0;
		return Number.isFinite(n) ? n : 0;
	}

	/**
	 * Calculates derived statistics from raw book and session data.
	 * @param book - Book statistics from database
	 * @param sessions - Reading session data
	 * @returns Calculated values like percent complete, reading status
	 */
	private calculateDerivedStatistics(
		book: BookStatistics,
		sessions: PageStatData[],
	): ReadingProgress {
		const totalReadPages = this.toNumber(book.total_read_pages);
		const totalReadTime = this.toNumber(book.total_read_time);
		const pages = this.toNumber(book.pages);
		const rawPercent = pages > 0 ? (totalReadPages / pages) * 100 : 0;

		const lastOpenSec = this.toNumber(book.last_open);
		const lastOpenDate = lastOpenSec > 0 ? new Date(lastOpenSec * 1000) : null;

		const firstStartSec = sessions[0]
			? this.toNumber(sessions[0].start_time)
			: 0;
		const firstReadDate =
			firstStartSec > 0 ? new Date(firstStartSec * 1000) : null;

		const lastReadDate =
			lastOpenDate && firstReadDate && lastOpenDate < firstReadDate
				? firstReadDate
				: (lastOpenDate ?? firstReadDate);

		const percentComplete = Math.max(0, Math.min(100, Math.round(rawPercent)));

		const readingStatus: ReadingStatus =
			sessions.length === 0
				? "unstarted"
				: percentComplete >= 100
					? "completed"
					: "ongoing";

		return {
			percentComplete,
			averageTimePerPage:
				totalReadPages > 0 && totalReadTime > 0
					? totalReadTime / totalReadPages
					: 0,
			firstReadDate,
			lastReadDate,
			readingStatus,
		};
	}

	// Map database row to typed BookStatistics with safety conversions
	private mapBookRow(o: any): BookStatistics {
		if (
			!o ||
			(typeof o.id !== "number" && typeof o.id !== "string") ||
			typeof o.title !== "string"
		) {
			this.log.warn("Received malformed book row from database", o);
			return {
				id: 0,
				title: "Invalid Row",
				authors: "",
				md5: "",
				last_open: 0,
				pages: 0,
				total_read_pages: 0,
				total_read_time: 0,
				series: undefined,
				language: undefined,
			};
		}
		return {
			id: this.toNumber(o.id),
			md5: String(o.md5 ?? ""),
			last_open: this.toNumber(o.last_open),
			pages: this.toNumber(o.pages),
			total_read_pages: this.toNumber(o.total_read_pages),
			total_read_time: this.toNumber(o.total_read_time),
			title: String(o.title),
			authors: String(o.authors ?? ""),
			series: o.series ? String(o.series) : undefined,
			language: o.language ? String(o.language) : undefined,
		};
	}
}
