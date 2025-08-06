import path from "node:path";
import type { Database, SqlValue } from "sql.js";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type {
	BookStatistics,
	Disposable,
	KoreaderHighlightImporterSettings,
	PageStatData,
	ReadingProgress,
	ReadingStatus,
	SettingsObserver,
} from "src/types";
import { ConcurrentDatabase } from "src/utils/ConcurrentDatabase";
import type { CacheManager } from "src/utils/cache/CacheManager";
import type { LruCache } from "src/utils/cache/LruCache";
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
const DB_SCHEMA_VERSION = 1;

const BOOK_COLUMNS =
	`id, md5, last_open, pages, total_read_time, total_read_pages, title, authors, series, language`
		.trim()
		.replace(/\s+/g, " ");

const SQL_FIND_BOOK_BY_MD5 = /*sql*/ `SELECT ${BOOK_COLUMNS} FROM book WHERE md5 = ? AND title = ?`;
const SQL_FIND_BOOK_BY_AUTHOR_TITLE = /*sql*/ `SELECT ${BOOK_COLUMNS} FROM book WHERE authors = ? AND title = ?`;
const SQL_GET_SESSIONS = /*sql*/ `SELECT * FROM page_stat_data WHERE id_book = ? ORDER BY start_time`;

export class DeviceStatisticsService implements SettingsObserver, Disposable {
	private readonly SCOPE = "DeviceStatisticsService";
	private settings: KoreaderHighlightImporterSettings;
	private db: Database | null = null;
	private dbInit: Promise<void> | null = null;
	private dbFilePath: string | null = null;
	private concurrentDb: ConcurrentDatabase | null = null;

	private statsCache: LruCache<string, BookStatisticsBundle | null>;
	private deviceRootCache = new Map<string, string | null>();

	constructor(
		private plugin: KoreaderImporterPlugin,
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
	}

	public async findBookStatistics(
		title: string,
		authors: string,
		md5?: string,
	): Promise<BookStatisticsBundle | null> {
		const db = await this.getConcurrentDb();
		if (!db) return null;

		return db.execute(async (database) => {
			const bookRow = await this.findBook(database, title, authors, md5);
			if (!bookRow) return null;

			const cacheKey = `${bookRow.id}`;
			const cachedStats = this.statsCache.get(cacheKey);
			if (cachedStats) {
				this.loggingService.info(
					this.SCOPE,
					`[CACHE HIT] Statistics for: "${title}"`,
				);
				return cachedStats;
			}

			this.loggingService.info(
				this.SCOPE,
				`Querying statistics for: "${title}"`,
			);
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

	private async findBook(
		db: Database,
		title: string,
		authors: string,
		md5?: string,
	): Promise<BookStatistics | null> {
		let row: BookStatistics | null = null;
		if (md5) {
			row = this.queryFirstRow<BookStatistics>(db, SQL_FIND_BOOK_BY_MD5, [
				md5,
				title,
			]);
		}
		if (!row) {
			row = this.queryFirstRow<BookStatistics>(
				db,
				SQL_FIND_BOOK_BY_AUTHOR_TITLE,
				[authors, title],
			);
		}
		return row ?? null;
	}

	private async ensureDbOpen(): Promise<void> {
		// Retained for backward compatibility; now just ensures dbFilePath is memoized.
		await this.getDbFilePath();
	}

	private upgradeSchema(db: Database): void {
		const res = db.exec("PRAGMA user_version;");
		const currentVersion = Number(res[0]?.values[0]?.[0] ?? 0);

		if (currentVersion < DB_SCHEMA_VERSION) {
			this.loggingService.info(
				this.SCOPE,
				`Upgrading stats DB schema v${currentVersion} -> v${DB_SCHEMA_VERSION}`,
			);
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_page_stat_book ON page_stat_data(id_book);",
			);
			db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION};`);
		}
	}

	onSettingsChanged(newSettings: KoreaderHighlightImporterSettings): void {
		if (newSettings.koreaderMountPoint !== this.settings.koreaderMountPoint) {
			this.loggingService.info(
				this.SCOPE,
				"Mount point changed, closing stats DB.",
			);
			this.dispose();
		}
		this.settings = newSettings;
	}

	dispose(): void {
		if (this.dbFilePath) {
			this.sqlJsManager.closeDatabase(this.dbFilePath);
		}
		this.db = null;
		this.dbFilePath = null;
		this.concurrentDb = null;
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
			try {
				if (await this.fsService.getNodeStats(path.join(p, ".adds"))) {
					this.deviceRootCache.set(mountPoint, p);
					return p;
				}
			} catch {
				/* no-op */
			}
			const parent = path.dirname(p);
			if (parent === p) break;
			p = parent;
		}
		this.deviceRootCache.set(mountPoint, null);
		return null;
	}

	/**
	 * Executes a SQL query and returns the first row.
	 * @param db - SQLite database instance
	 * @param sql - SQL query string
	 * @param params - Query parameters
	 * @returns First row as object or null
	 */
	private async getDbFilePath(): Promise<string | null> {
		if (this.dbFilePath) return this.dbFilePath;

		try {
			const mountPoint = this.settings.koreaderMountPoint;
			if (!mountPoint) {
				this.loggingService.warn(
					this.SCOPE,
					"Mount point not set, cannot open stats DB.",
				);
				return null;
			}

			const deviceRoot = await this.findDeviceRoot(mountPoint);
			if (!deviceRoot) {
				this.loggingService.warn(
					this.SCOPE,
					`Could not find KOReader .adds in ${mountPoint}`,
				);
				return null;
			}

			const filePath = path.join(
				deviceRoot,
				".adds/koreader/settings/statistics.sqlite3",
			);

			if (!(await this.fsService.nodeFileExists(filePath))) {
				this.loggingService.warn(
					this.SCOPE,
					`Statistics DB not found or not accessible at ${filePath}. This is expected in a sandboxed environment. Continuing without device statistics.`,
				);
				return null;
			}

			// Open once to verify and apply any upgrades; cache path for locking
			const db = await this.sqlJsManager.openDatabase(filePath);
			this.upgradeSchema(db);
			this.db = db;
			this.dbFilePath = filePath;
			// Create a read-focused concurrent DB (no markDirty)
			this.concurrentDb = new ConcurrentDatabase(async () => {
				// openDatabase returns cached DB
				return await this.sqlJsManager.openDatabase(filePath);
			});
			this.loggingService.info(this.SCOPE, `Opened stats DB: ${filePath}`);
			return this.dbFilePath;
		} catch (error) {
			this.loggingService.error(
				this.SCOPE,
				"Failed to open/process statistics DB",
				error,
			);
			this.dispose(); // Ensure cleanup on failure
			return null;
		}
	}

	private async getConcurrentDb(): Promise<ConcurrentDatabase | null> {
		const dbFilePath = await this.getDbFilePath();
		if (!dbFilePath) return null;
		if (this.concurrentDb) return this.concurrentDb;
		// Fallback safety: create wrapper if missing
		this.concurrentDb = new ConcurrentDatabase(async () => {
			return await this.sqlJsManager.openDatabase(dbFilePath);
		});
		return this.concurrentDb;
	}

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

		const firstReadDate = sessions[0]
			? new Date(sessions[0].start_time * 1000)
			: null;
		const lastOpenDate = new Date(Math.max(0, book.last_open) * 1000);
		const lastReadDate =
			firstReadDate && lastOpenDate < firstReadDate
				? firstReadDate
				: lastOpenDate;

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
}
