import path from "node:path";
import type { Database, SqlValue } from "sql.js";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { CacheManager } from "src/utils/cache/CacheManager";
import type { LruCache } from "src/utils/cache/LruCache";
import type {
	BookStatistics,
	Disposable,
	KoreaderHighlightImporterSettings,
	PageStatData,
	ReadingProgress,
	ReadingStatus,
	SettingsObserver,
} from "../../types";
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
	private dbFileMTimeMs = 0;
	private dbFileSize = 0;
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

	public warmUp(): void {
		this.ensureDbOpen().catch((error) => {
			this.loggingService.warn(
				this.SCOPE,
				"Pre-warming statistics DB failed (this is non-critical).",
				error,
			);
		});
	}

	/**
	 * Retrieves reading statistics from KOReader's statistics database.
	 * Attempts multiple lookup strategies: MD5+title, MD5 only, then author+title.
	 * @param title - Book title
	 * @param authors - Book authors
	 * @param md5 - Optional MD5 hash of the book file
	 * @returns Complete statistics including reading sessions, or null if not found
	 */
	public async findBookStatistics(
		title: string,
		authors: string,
		md5?: string,
	): Promise<BookStatisticsBundle | null> {
		await this.ensureDbOpen();
		if (!this.db) return null;

		const bookRow = await this.findBook(this.db, title, authors, md5);
		if (!bookRow) return null;

		const cacheKey = `${bookRow.id}:${this.dbFileMTimeMs}:${this.dbFileSize}`;
		const cachedStats = this.statsCache.get(cacheKey);
		if (cachedStats !== undefined) {
			this.loggingService.info(
				this.SCOPE,
				`[CACHE HIT] Statistics for: "${title}"`,
			);
			return cachedStats;
		}

		this.loggingService.info(this.SCOPE, `Querying statistics for: "${title}"`);

		const sessions = this.queryAllRows<PageStatData>(
			this.db,
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
	private async isCurrent(): Promise<boolean> {
		if (!this.db || !this.dbFilePath) return false;
		try {
			const stats = await this.fsService.getNodeStats(this.dbFilePath);
			return stats
				? stats.mtimeMs === this.dbFileMTimeMs && stats.size === this.dbFileSize
				: false;
		} catch {
			return false;
		}
	}

	private async ensureDbOpen(): Promise<void> {
		if (this.db && (await this.isCurrent())) {
			return;
		}

		if (this.dbInit) {
			return this.dbInit;
		}

		this.dbInit = (async () => {
			try {
				if (this.db) {
					this.dispose();
				}

				const mountPoint = this.settings.koreaderMountPoint;
				if (!mountPoint) {
					this.loggingService.warn(
						this.SCOPE,
						"Mount point not set, cannot open stats DB.",
					);
					return;
				}

				const deviceRoot = await this.findDeviceRoot(mountPoint);
				if (!deviceRoot) {
					this.loggingService.warn(
						this.SCOPE,
						`Could not find KOReader .adds in ${mountPoint}`,
					);
					return;
				}

				const filePath = path.join(
					deviceRoot,
					".adds/koreader/settings/statistics.sqlite3",
				);
				const SQL = await this.sqlJsManager.getSqlJs();
				const fileBuf = await this.fsService.readNodeFile(filePath, true);

				const db = new SQL.Database(fileBuf);
				this.upgradeSchema(db);

				const stats = await this.fsService.getNodeStats(filePath);
				if (!stats) {
					db.close();
					throw new Error(
						`Critical error: Could not get file stats for DB file that was just read: ${filePath}`,
					);
				}

				this.db = db;
				this.dbFilePath = filePath;
				this.dbFileMTimeMs = stats.mtimeMs;
				this.dbFileSize = stats.size;

				this.loggingService.info(this.SCOPE, `Opened stats DB: ${filePath}`);
			} catch (error) {
				this.loggingService.error(
					this.SCOPE,
					"Failed to open/process statistics DB",
					error,
				);
				this.dispose();
				throw error;
			} finally {
				this.dbInit = null;
			}
		})();

		return this.dbInit;
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

	/**
	 * Cleans up database connections and saves pending changes.
	 * Called when plugin is disabled or unloaded.
	 */
	dispose(): void {
		this.db?.close();
		this.db = null;
		this.dbFilePath = null;
		this.dbFileMTimeMs = 0;
		this.dbFileSize = 0;
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
