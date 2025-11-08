import type { Database } from "sql.js";
import { memoizeAsync } from "src/lib/cache";
import type { CacheManager } from "src/lib/cache/CacheManager";
import type { IterableCache } from "src/lib/cache/types";
import { asyncLazy, runPool } from "src/lib/concurrency";
import { ConcurrentDatabase } from "src/lib/concurrency/ConcurrentDatabase";
import { isErr } from "src/lib/core/result";
import * as statisticsCore from "src/lib/database/statisticsCore";
import { Pathing } from "src/lib/pathing";
import type KoreaderImporterPlugin from "src/main";
import type {
	BookStatisticsBundle,
	Disposable,
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { SqlJsManager } from "../SqlJsManager";

// --- Constants ---
const METADATA_REGEX = /^metadata\.(.+)\.lua$/i;

export class DeviceService implements SettingsObserver, Disposable {
	private readonly log;
	private settings: KoreaderHighlightImporterSettings;
	private dbFilePath: string | null = null;
	private inMemoryDb: Database | null = null;
	private dbFileMtimeMs: number | null = null;
	private getCdbLazy: () => Promise<ConcurrentDatabase | null>;

	private sdrDirCache: IterableCache<string, Promise<string[]>>;
	private metadataNameCache: IterableCache<string, string | null>;
	private findSdrDirectoriesWithMetadataMemoized: (
		scanPath: string,
	) => Promise<string[]>;
	private statsCache: IterableCache<string, BookStatisticsBundle | null>;

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
	}

	// --- Path Resolution ---
	async getActiveScanPath(): Promise<string | null> {
		return this._validateScanPath(); // Directly validates the user-configured path
	}

	async getStatsDbPath(): Promise<string | null> {
		const scanPath = await this._validateScanPath();
		if (!scanPath) return null;

		const override = this.settings.statsDbPathOverride?.trim();
		if (override) {
			return (await this.fs.nodeFileExists(override)) ? override : null;
		}
		// The findStatsDatabase method already contains the necessary walk-up logic
		return this.findStatsDatabase(scanPath);
	}

	// --- Discovery & Validation ---

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
	 * Find the statistics database using the unified walk-up heuristic.
	 * Walks up from the scan path to find KOReader root markers, then constructs the DB path.
	 */
	private async findStatsDatabase(scanPath: string): Promise<string | null> {
		const MAX_WALK_UP = 5;
		let currentPath = scanPath;

		for (let i = 0; i < MAX_WALK_UP; i++) {
			// Check for the presence of the marker directories.
			const koboMarker = Pathing.joinSystemPath(currentPath, ".adds");
			const genericMarker = Pathing.joinSystemPath(currentPath, "koreader");

			const [koboMarkerExists, genericMarkerExists] = await Promise.all([
				this.fs.nodeFileExists(koboMarker), // Assuming this checks for directories too
				this.fs.nodeFileExists(genericMarker),
			]);

			let koReaderRoot: string | null = null;
			if (koboMarkerExists || genericMarkerExists) {
				koReaderRoot = currentPath;
			}

			if (koReaderRoot) {
				const dbPathsToCheck = [
					Pathing.joinSystemPath(
						koReaderRoot,
						".adds/koreader/settings/statistics.sqlite3",
					),
					Pathing.joinSystemPath(
						koReaderRoot,
						"koreader/settings/statistics.sqlite3",
					),
				];

				for (const dbPath of dbPathsToCheck) {
					if (await this.fs.nodeFileExists(dbPath)) {
						this.log.info(`Found stats DB via heuristic: ${dbPath}`);
						return dbPath;
					}
				}
			}

			// Go up one level.
			const parent = Pathing.systemDirname(currentPath);
			if (parent === currentPath) {
				break; // Reached filesystem root
			}
			currentPath = parent;
		}

		this.log.info("Statistics DB not found via walk-up heuristic.");
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
			for await (const result of this.fs.iterateNodeDirectory(dir)) {
				if (isErr(result)) continue;
				const { dirent } = result.value;
				if (++checked > maxCheck) return false;
				if (dirent.isDirectory() && dirent.name.endsWith(".sdr")) return true;
				if (dirent.isDirectory() && !dirent.name.startsWith(".")) {
					const found = await checkDir(
						Pathing.joinSystemPath(dir, dirent.name),
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

	// --- SDR Finding ---

	async *iterSdrDirectories(): AsyncGenerator<string> {
		for (const file of await this.findSdrDirectoriesWithMetadata()) yield file;
	}

	async findSdrDirectoriesWithMetadata(opts?: {
		signal?: AbortSignal;
	}): Promise<string[]> {
		const scanPath = await this.getActiveScanPath();
		if (!scanPath) return [];
		// If a signal is provided, bypass memoization to be responsive
		if (opts?.signal) return this.scan(scanPath, opts);
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

		const fullPath = Pathing.joinSystemPath(sdrDir, name);
		this.log.info("Reading metadata:", fullPath);
		const res = await this.fs.readNodeFileText(fullPath);
		if (isErr(res)) {
			this.log.error(`Failed to read metadata file: ${fullPath}`, res.error);
			return null;
		}
		return res.value;
	}

	clearCache(): void {
		this.cacheManager.clear("device.*");
		this.log.info("DeviceService caches cleared.");
	}

	private async scan(
		scanPath: string,
		opts?: { signal?: AbortSignal },
	): Promise<string[]> {
		const excluded = new Set(
			this.settings.excludedFolders.map((e) => e.trim().toLowerCase()),
		);
		const sdrDirs = new Set<string>();

		const t0 = performance.now();
		// Phase 1: Stream traversal under scanPath only
		for await (const result of this.fs.iterateNodeDirectory(scanPath, {
			recursive: true,
			signal: opts?.signal,
			shouldEnterDir: (_full, name) => {
				const lower = name.toLowerCase();
				if (excluded.has(lower)) return false;
				if (lower === "$recycle.bin" || lower.startsWith(".")) return false;
				return true;
			},
		})) {
			if (isErr(result)) continue;
			const { path, dirent } = result.value;
			if (dirent.isDirectory() && dirent.name.endsWith(".sdr")) {
				sdrDirs.add(path);
			}
		}
		const t1 = performance.now();

		// Phase 2: Concurrent metadata.lua verification inside discovered .sdr dirs
		const results: string[] = [];
		const stream = runPool(
			sdrDirs,
			async (sdrPath) => {
				const metadataFileName = await this.getMetadataFileName(
					sdrPath,
					scanPath,
				);
				return metadataFileName
					? Pathing.joinSystemPath(sdrPath, metadataFileName)
					: null;
			},
			{ concurrency: 16, signal: opts?.signal },
		);

		for await (const res of stream) {
			if (res.ok && res.value) results.push(res.value);
			else if (!res.ok) this.log.warn("Error checking SDR dir", res.error);
		}
		const t2 = performance.now();
		this.log.info(
			`Scan finished. Found ${results.length} metadata files. ` +
				`Traversal: ${(t1 - t0).toFixed(0)}ms, probe: ${(t2 - t1).toFixed(0)}ms.`,
		);
		return results;
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

		for await (const result of this.fs.iterateNodeDirectory(dir)) {
			if (isErr(result)) continue;
			const { dirent } = result.value;
			if (!dirent.isFile()) continue;

			const match = dirent.name.match(METADATA_REGEX);
			if (match) {
				const ext = match[1]?.toLowerCase();
				if (allowAll || allow.has(ext)) {
					this.metadataNameCache.set(cacheKey, dirent.name);
					return dirent.name;
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
		signal?: AbortSignal,
	): Promise<BookStatisticsBundle | null> {
		const db = await this.getConcurrentDb();
		if (!db || signal?.aborted) return null;

		return db.execute(
			async (database) => {
				const cacheKey = `${title}::${authors}::${md5 ?? ""}`;
				const cached = this.statsCache.get(cacheKey);
				if (cached) {
					this.log.info(`[CACHE HIT] Statistics for: "${title}"`);
					return cached;
				}

				if (signal?.aborted) return null;

				this.log.info(`Querying statistics for: "${title}"`);
				const result = statisticsCore.getBookStatisticsBundle(
					database,
					title,
					authors,
					md5,
					signal,
				);

				if (result) {
					this.statsCache.set(cacheKey, result);
				}
				return result;
			},
			false,
			signal,
		);
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
				bytesRes.error,
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

	/**
	 * Get the occurrence count of an MD5 in the KOReader book table.
	 */
	async getMd5OccurrenceCount(md5: string): Promise<number> {
		const db = await this.getConcurrentDb();
		if (!db) return 0;

		return db.execute(async (database) => {
			const result = statisticsCore.getMd5OccurrenceCount(database, md5);
			return result;
		}, false);
	}

	/**
	 * Query books from KOReader stats DB that match the given identifiers.
	 */
	async queryBooksByIdentifiers(
		identifiers: Array<{ scheme: string; value: string }>,
	): Promise<
		Array<{ id: number; md5: string; title: string; authors: string }>
	> {
		const db = await this.getConcurrentDb();
		if (!db) return [];

		return db.execute(async (database) => {
			const result = statisticsCore.queryBooksByIdentifiers(
				database,
				identifiers,
			);
			return result;
		}, false);
	}
}
