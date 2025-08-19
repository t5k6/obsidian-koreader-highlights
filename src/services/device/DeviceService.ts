import pLimit from "p-limit";
import type { Database, SqlValue } from "sql.js";
import { memoizeAsync } from "src/lib/cache";
import type { CacheManager } from "src/lib/cache/CacheManager";
import type { IterableCache } from "src/lib/cache/types";
import { asyncLazy } from "src/lib/concurrency";
import { ConcurrentDatabase } from "src/lib/concurrency/ConcurrentDatabase";
import { throwIfAborted } from "src/lib/concurrency/cancellation";
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
import { detectLayout } from "./layouts";
import type { KOReaderEnvironment } from "./types";

// --- Constants ---
const SDR_SUFFIX = ".sdr";
const METADATA_REGEX = /^metadata\.(.+)\.lua$/i;
const MAX_PARALLEL_IO = 32;

const BOOK_COLUMNS =
	`id, md5, last_open, pages, total_read_time, total_read_pages, title, authors, series, language`
		.trim()
		.replace(/\s+/g, " ");

// Koreader DB sometimes shares the same md5 for different books
// So we need to check both md5 and title
const SQL_FIND_BOOK_BY_MD5 = /*sql*/ `SELECT ${BOOK_COLUMNS} FROM book WHERE md5 = ? AND title = ?`;
const SQL_FIND_BOOK_BY_AUTHOR_TITLE = /*sql*/ `SELECT ${BOOK_COLUMNS} FROM book WHERE authors = ? AND title = ?`;
const SQL_GET_SESSIONS = /*sql*/ `SELECT * FROM page_stat_data WHERE id_book = ? ORDER BY start_time`;

export interface BookStatisticsBundle {
	book: BookStatistics;
	readingSessions: PageStatData[];
	derived: ReadingProgress;
}

export class DeviceService implements SettingsObserver, Disposable {
	private readonly log;
	private settings: KoreaderHighlightImporterSettings;
	private dbFilePath: string | null = null;
	private inMemoryDb: Database | null = null;
	private dbFileMtimeMs: number | null = null;
	private getCdbLazy: () => Promise<ConcurrentDatabase | null>;

	// Simplified discovery config
	private readonly STATS_DB_PATTERNS = [
		".adds/koreader/settings/statistics.sqlite3", // Kobo
		"koreader/settings/statistics.sqlite3", // Generic
	] as const;

	private readonly MAX_WALK_UP_DEPTH = 3;

	private sdrDirCache: IterableCache<string, Promise<string[]>>;
	private metadataNameCache: IterableCache<string, string | null>;
	private findSdrDirectoriesWithMetadataMemoized: (
		scanPath: string,
	) => Promise<string[]>;
	private getEnvironmentMemoized: (
		settingsKey: string,
	) => Promise<KOReaderEnvironment | null>;

	private statsCache: IterableCache<string, BookStatisticsBundle | null>;

	private readonly limit = pLimit(MAX_PARALLEL_IO);

	// Readiness guard to avoid redundant env discovery from whenReady()
	private envInitialized = false;

	constructor(
		private _plugin: KoreaderImporterPlugin,
		private fs: FileSystemService,
		private sqlJsManager: SqlJsManager,
		private cacheManager: CacheManager,
		loggingService: LoggingService,
	) {
		this.settings = this._plugin.settings;
		this.log = loggingService.scoped("DeviceService");

		// Caches (merged from old services, single prefix)
		this.sdrDirCache = cacheManager.createMap("device.sdr.dirPromise");
		this.metadataNameCache = cacheManager.createMap("device.sdr.metaName");
		this.statsCache = cacheManager.createLru("device.stats.derived", 100);

		this.findSdrDirectoriesWithMetadataMemoized = memoizeAsync(
			this.sdrDirCache,
			(scanPath: string) => this.scan(scanPath),
		);

		this.getEnvironmentMemoized = memoizeAsync(
			cacheManager.createMap("device.env.discovery"),
			(_: string) => this._resolveEnvironment(),
		);

		this.getCdbLazy = asyncLazy<ConcurrentDatabase | null>(() =>
			this.createCdbInstance(),
		);
	}

	// SettingsObserver
	onSettingsChanged(newSettings: KoreaderHighlightImporterSettings): void {
		if (
			newSettings.koreaderScanPath !== this.settings.koreaderScanPath ||
			newSettings.statsDbPathOverride !== this.settings.statsDbPathOverride
		) {
			this.log.info(
				"Environment settings changed, resetting caches and DB connection.",
			);
			this.cacheManager.clear("device.*");
			this.dispose(); // This also resets getCdbLazy
		}
		this.settings = newSettings;
	}

	// Disposable
	dispose(): void {
		try {
			this.inMemoryDb?.close?.();
		} catch {
			/* noop */
		}
		this.inMemoryDb = null;
		this.dbFilePath = null;
		this.dbFileMtimeMs = null;
		this.getCdbLazy = asyncLazy<ConcurrentDatabase | null>(() =>
			this.createCdbInstance(),
		);
		this.statsCache.clear();
		this.envInitialized = false;
	}

	// --- Readiness Gate ---
	async whenReady(): Promise<void> {
		if (!this.envInitialized) {
			await this.getEnvironment();
			this.envInitialized = true;
		}
	}

	// --- Environment Resolution ---
	async getEnvironment(): Promise<KOReaderEnvironment | null> {
		return this.getEnvironmentMemoized(this._settingsKey());
	}

	async getActiveScanPath(): Promise<string | null> {
		return (await this.getEnvironment())?.scanPath ?? null;
	}

	async getDeviceRoot(): Promise<string | null> {
		return (await this.getEnvironment())?.rootPath ?? null;
	}

	async getStatsDbPath(): Promise<string | null> {
		return (await this.getEnvironment())?.statsDbPath ?? null;
	}

	private _settingsKey(): string {
		const s = this.settings;
		const scan = s.koreaderScanPath?.trim() || "";
		const override = s.statsDbPathOverride?.trim() || "";
		return `${scan}__${override}`;
	}

	private async _resolveEnvironment(): Promise<KOReaderEnvironment | null> {
		const scanPath = await this._validateScanPath();
		if (!scanPath) return null;

		const override = this.settings.statsDbPathOverride?.trim();
		if (override) {
			return this._handleOverride(scanPath, override);
		}
		return this._discoverEnvironment(scanPath);
	}

	// --- Simplified Discovery & Validation (non-breaking addition) ---

	/**
	 * Validate that a scan path likely contains KOReader data.
	 * Returns lightweight signals for UI without committing to full env discovery.
	 */
	public async validateScanPath(scanPath: string): Promise<{
		valid: boolean;
		statsDbPath: string | null;
		hasSdrFolders: boolean;
	}> {
		const st = await this.fs.getNodeStats(scanPath);
		if (!st.ok || !st.value.isDirectory()) {
			return { valid: false, statsDbPath: null, hasSdrFolders: false };
		}

		const statsDbPath = await this.findStatsDatabase(scanPath);
		const hasSdrFolders = await this.hasSdrFoldersQuickCheck(scanPath);

		return {
			valid: Boolean(statsDbPath) || hasSdrFolders,
			statsDbPath,
			hasSdrFolders,
		};
	}

	/**
	 * Directly search for the statistics database from the given path.
	 * Tries direct patterns, then walks up a few levels, then performs a bounded deep search.
	 */
	private async findStatsDatabase(scanPath: string): Promise<string | null> {
		// Try direct paths relative to provided scanPath
		for (const pattern of this.STATS_DB_PATTERNS) {
			const candidate = this.fs.joinSystemPath(scanPath, pattern);
			if (await this.fs.nodeFileExists(candidate)) {
				this.log.info(`Found stats DB via direct path: ${candidate}`);
				return candidate;
			}
		}

		// Walk up limited depth
		let currentPath = scanPath;
		for (let depth = 0; depth < this.MAX_WALK_UP_DEPTH; depth++) {
			for (const pattern of this.STATS_DB_PATTERNS) {
				const candidate = this.fs.joinSystemPath(currentPath, pattern);
				if (await this.fs.nodeFileExists(candidate)) {
					this.log.info(
						`Found stats DB via walk-up at depth ${depth}: ${candidate}`,
					);
					return candidate;
				}
			}
			const parent = this.fs.systemDirname(currentPath);
			if (parent === currentPath) break;
			currentPath = parent;
		}

		// Bounded deep search from scan path
		return this.searchForStatsDb(scanPath);
	}

	/**
	 * Breadth-first bounded search for statistics.sqlite3 under common subfolders.
	 */
	private async searchForStatsDb(
		root: string,
		maxDepth: number = 3,
	): Promise<string | null> {
		const queue: Array<[string, number]> = [[root, 0]];
		while (queue.length > 0) {
			const [dir, depth] = queue.shift()!;
			if (depth > maxDepth) continue;

			for (const pattern of this.STATS_DB_PATTERNS) {
				const candidate = this.fs.joinSystemPath(dir, pattern);
				if (await this.fs.nodeFileExists(candidate)) {
					this.log.info(`Found stats DB via deep search: ${candidate}`);
					return candidate;
				}
			}

			try {
				for await (const entry of this.fs.iterateNodeDirectory(dir)) {
					if (!entry.isDirectory()) continue;
					const name = entry.name.toLowerCase();
					// Likely candidates or non-hidden
					if (
						name === ".adds" ||
						name === "koreader" ||
						!name.startsWith(".")
					) {
						queue.push([this.fs.joinSystemPath(dir, entry.name), depth + 1]);
					}
				}
			} catch {
				// Skip unreadable directories
			}
		}
		return null;
	}

	/**
	 * Quick bounded check for existence of any .sdr folders beneath the path.
	 */
	private async hasSdrFoldersQuickCheck(
		scanPath: string,
		maxCheck: number = 100,
	): Promise<boolean> {
		let checked = 0;
		const checkDir = async (
			dir: string,
			depth: number = 0,
		): Promise<boolean> => {
			if (depth > 2 || checked > maxCheck) return false;
			for await (const entry of this.fs.iterateNodeDirectory(dir)) {
				if (++checked > maxCheck) return false;
				if (entry.isDirectory() && entry.name.endsWith(".sdr")) return true;
				if (entry.isDirectory() && !entry.name.startsWith(".")) {
					const found = await checkDir(
						this.fs.joinSystemPath(dir, entry.name),
						depth + 1,
					);
					if (found) return true;
				}
			}
			return false;
		};
		return checkDir(scanPath);
	}

	private async _validateScanPath(): Promise<string | null> {
		const configured = this.settings.koreaderScanPath?.trim();
		if (!configured) return null;
		const st = await this.fs.getNodeStats(configured);
		if (st.ok && st.value.isDirectory()) {
			return configured;
		}
		this.log.warn(
			"Configured scan path is not a usable directory:",
			configured,
		);
		return null;
	}

	private async _handleOverride(
		scanPath: string,
		override: string,
	): Promise<KOReaderEnvironment> {
		const explain = [`User override for stats DB is set: ${override}`];
		const exists = await this.fs.nodeFileExists(override);

		if (!exists) {
			explain.push("Error: Override path does not point to an existing file.");
		}

		return {
			scanPath,
			rootPath: null,
			statsDbPath: exists ? override : null,
			layout: "unknown",
			discoveredBy: "override",
			explain,
		};
	}

	private async _discoverEnvironment(
		scanPath: string,
	): Promise<KOReaderEnvironment> {
		const explain: string[] = [
			`Starting discovery from scan path: ${scanPath}`,
		];

		// Fast-path
		{
			const res = await detectLayout(this.fs, scanPath);
			if (res) {
				explain.push(...res.explain);
				this.log.info(`Environment discovered via fast-path at scan path.`);
				return { scanPath, ...res, discoveredBy: res.layout, explain };
			}
		}
		explain.push("Fast-path: scan path is not a recognized KOReader root.");

		// Walk-up
		let currentPath = this.fs.systemResolve(scanPath);
		for (let i = 0; i < 25; i++) {
			explain.push(`Walk-up: probing at '${currentPath}'`);
			const res = await detectLayout(this.fs, currentPath);
			if (res) {
				explain.push(...res.explain);
				this.log.info(
					`Environment discovered via walk-up at '${currentPath}'.`,
				);
				return { scanPath, ...res, discoveredBy: res.layout, explain };
			}
			const parent = this.fs.systemDirname(currentPath);
			if (parent === currentPath) break;
			currentPath = parent;
		}

		this.log.warn(
			"KOReader environment discovery failed for scan path:",
			scanPath,
		);
		explain.push("Walk-up failed: no layouts matched up to filesystem root.");
		return {
			scanPath,
			rootPath: null,
			statsDbPath: null,
			layout: "unknown",
			discoveredBy: "none",
			explain,
		};
	}

	// --- SDR Finding ---

	async *iterSdrDirectories(): AsyncGenerator<string> {
		for (const file of await this.findSdrDirectoriesWithMetadata()) yield file;
	}

	async findSdrDirectoriesWithMetadata(opts?: {
		signal?: AbortSignal;
	}): Promise<string[]> {
		const scanPath = await this.getActiveScanPath();
		if (!scanPath) return [];
		// When a signal is provided, bypass memoization to ensure responsive cancellation.
		if (opts?.signal) {
			return this.scan(scanPath, opts);
		}
		return this.findSdrDirectoriesWithMetadataMemoized(scanPath);
	}

	async readMetadataFileContent(sdrDir: string): Promise<string | null> {
		const mountPoint = await this.getActiveScanPath();
		if (!mountPoint) {
			this.log.warn("Cannot read metadata file without an active mount point.");
			return null;
		}

		const name = await this.getMetadataFileName(sdrDir, mountPoint);
		if (!name) return null;

		const fullPath = this.fs.joinSystemPath(sdrDir, name);
		this.log.info("Reading metadata:", fullPath);
		const res = await this.fs.readNodeFile(fullPath, false);
		if (isErr(res)) {
			this.log.error(
				`Failed to read metadata file: ${fullPath}`,
				(res as any).error ?? res,
			);
			return null;
		}
		const v = res.value;
		return typeof v === "string" ? v : new TextDecoder().decode(v);
	}

	clearCache(): void {
		this.cacheManager.clear("device.*");
		this.log.info("DeviceService caches cleared.");
	}

	private async scan(
		scanPath: string,
		opts?: { signal?: AbortSignal },
	): Promise<string[]> {
		const mountPoint = scanPath;

		const { excludedFolders } = this.settings;
		const root = mountPoint;
		const excluded = new Set<string>(
			excludedFolders.map((e: string) => e.trim().toLowerCase()),
		);

		const results: string[] = [];
		await this.walk(root, excluded, results, mountPoint, opts?.signal);
		this.log.info(`Scan finished. Found ${results.length} metadata files.`);
		return results;
	}

	private async walk(
		dir: string,
		excluded: Set<string>,
		out: string[],
		mountPoint: string,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		const subdirTasks: Promise<void>[] = [];

		for await (const entry of this.fs.iterateNodeDirectory(dir)) {
			throwIfAborted(signal);
			if (!entry.isDirectory()) continue;
			if (excluded.has(entry.name.toLowerCase())) continue;

			const fullPath = this.fs.joinSystemPath(dir, entry.name);

			if (entry.name.endsWith(SDR_SUFFIX)) {
				const metadataFileName = await this.getMetadataFileName(
					fullPath,
					mountPoint,
				);
				if (metadataFileName) {
					out.push(this.fs.joinSystemPath(fullPath, metadataFileName));
				}
			} else if (!entry.name.startsWith(".") && entry.name !== "$RECYCLE.BIN") {
				subdirTasks.push(
					this.limit(() =>
						this.walk(fullPath, excluded, out, mountPoint, signal),
					),
				);
			}
		}

		if (subdirTasks.length) {
			await Promise.all(subdirTasks);
		}
	}

	private async getMetadataFileName(
		dir: string,
		mountPoint: string,
	): Promise<string | null> {
		const cacheKey = `${mountPoint}::${dir}`;
		const cached = this.metadataNameCache.get(cacheKey);
		if (cached !== undefined) return cached;

		const { allowedFileTypes } = this.settings;
		const allow = new Set<string>(
			allowedFileTypes
				.map((t: string) => t.trim().toLowerCase())
				.filter(Boolean),
		);
		const allowAll = allow.size === 0;

		for await (const entry of this.fs.iterateNodeDirectory(dir)) {
			if (!entry.isFile()) continue;

			const match = entry.name.match(METADATA_REGEX);
			if (match) {
				const ext = match[1]?.toLowerCase();
				if (allowAll || allow.has(ext)) {
					this.metadataNameCache.set(cacheKey, entry.name);
					return entry.name;
				}
			}
		}

		this.metadataNameCache.set(cacheKey, null);
		return null;
	}

	// --- Statistics ---

	async findBookStatistics(
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
				derived: calculateDerivedStatistics(bookRow, sessions),
			};

			this.statsCache.set(cacheKey, result);
			return result;
		});
	}

	private async refreshIfDeviceDbChanged(): Promise<void> {
		if (!this.dbFilePath) return;
		const stRes = await this.fs.getNodeStats(this.dbFilePath);
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
		return this.getCdbLazy();
	}

	private createCdbInstance = async (): Promise<ConcurrentDatabase | null> => {
		const filePath = await this.getStatsDbPath();
		if (!filePath) {
			this.log.info(
				"Statistics DB path not found or configured. Stats disabled.",
			);
			return null;
		}

		const bytesRes = await this.fs.readBinaryAuto(filePath);
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
		const stRes = await this.fs.getNodeStats(filePath);
		this.dbFileMtimeMs = isErr(stRes) ? null : stRes.value.mtimeMs;

		const cdb = new ConcurrentDatabase(async () => db);
		this.log.info(`Loaded KOReader stats DB into memory: ${filePath}`);
		return cdb;
	};

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

function toNumber(value: unknown): number {
	const n =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: 0;
	return Number.isFinite(n) ? n : 0;
}

function calculateDerivedStatistics(
	book: BookStatistics,
	sessions: PageStatData[],
): ReadingProgress {
	const totalReadPages = toNumber(book.total_read_pages);
	const totalReadTime = toNumber(book.total_read_time);
	const pages = toNumber(book.pages);
	const rawPercent = pages > 0 ? (totalReadPages / pages) * 100 : 0;

	const lastOpenSec = toNumber(book.last_open);
	const lastOpenDate = lastOpenSec > 0 ? new Date(lastOpenSec * 1000) : null;

	const firstStartSec = sessions[0] ? toNumber(sessions[0].start_time) : 0;
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
