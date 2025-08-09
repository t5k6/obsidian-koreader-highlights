import {
	type App,
	type CachedMetadata,
	type Debouncer,
	debounce,
	Notice,
	type TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import type { Database } from "sql.js";
import { INDEX_DB_VERSION } from "src/constants";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type {
	DebouncedFn,
	Disposable,
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import { ConcurrentDatabase } from "src/utils/ConcurrentDatabase";
import type { CacheManager } from "src/utils/cache/CacheManager";
import type { LruCache } from "src/utils/cache/LruCache";
import { CapabilityManager } from "../CapabilityManager";
import { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { SqlJsManager } from "../SqlJsManager";
import { ParallelIndexProcessor } from "./ParallelIndexProcessor";

const INDEX_DB_SCHEMA = `
PRAGMA foreign_keys = ON;

-- Conceptual books table (no file path)
CREATE TABLE IF NOT EXISTS book(
  key        TEXT PRIMARY KEY,
  id         INTEGER,
  title      TEXT NOT NULL,
  authors    TEXT
);

-- One row per physical file instance
CREATE TABLE IF NOT EXISTS book_instances(
  book_key   TEXT NOT NULL REFERENCES book(key) ON DELETE CASCADE,
  vault_path TEXT NOT NULL,
  PRIMARY KEY (book_key, vault_path)
);

-- Import source tracking (introduced in v2)
CREATE TABLE IF NOT EXISTS import_source(
  source_path TEXT PRIMARY KEY,
  last_processed_mtime INTEGER NOT NULL,
  last_processed_size INTEGER NOT NULL,
  newest_annotation_ts TEXT,
  last_success_ts INTEGER,
  last_error TEXT,
  book_key TEXT,
  md5 TEXT
);

-- Ensure a file path cannot belong to two different books
CREATE UNIQUE INDEX IF NOT EXISTS uniq_book_instance_path ON book_instances(vault_path);
CREATE INDEX IF NOT EXISTS idx_instances_book_key ON book_instances(book_key);
CREATE INDEX IF NOT EXISTS idx_import_source_book_key ON import_source(book_key);
CREATE INDEX IF NOT EXISTS idx_import_source_md5 ON import_source(md5);

-- GC: when the last instance is removed, delete the conceptual book
CREATE TRIGGER IF NOT EXISTS trg_gc_book AFTER DELETE ON book_instances
BEGIN
  DELETE FROM book
  WHERE key = OLD.book_key
    AND NOT EXISTS (SELECT 1 FROM book_instances WHERE book_key = OLD.book_key);
END;
`;

const CURRENT_DB_VERSION = INDEX_DB_VERSION;

function tableHasColumn(db: Database, table: string, column: string): boolean {
	try {
		const res = db.exec(`PRAGMA table_info(${table});`);
		const rows = res?.[0]?.values ?? [];
		for (const row of rows) {
			// PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
			const name = row?.[1];
			if (name === column) return true;
		}
	} catch {
		// If PRAGMA fails, assume column does not exist
	}
	return false;
}

function tableExists(db: Database, tableName: string): boolean {
	try {
		const stmt = db.prepare(
			'SELECT 1 FROM sqlite_master WHERE type="table" AND name=?',
		);
		try {
			stmt.bind([tableName]);
			const exists = stmt.step();
			return exists;
		} finally {
			stmt.free();
		}
	} catch {
		return false;
	}
}

function getUserVersion(db: Database): number {
	try {
		const res = db.exec("PRAGMA user_version");
		const v = res?.[0]?.values?.[0]?.[0];
		return typeof v === "number" ? v : 0;
	} catch {
		return 0;
	}
}

function setUserVersion(db: Database, v: number): void {
	db.run(`PRAGMA user_version = ${v};`);
}

function migrateDb(db: Database): void {
	const v = getUserVersion(db);

	// --- Remediation for databases incorrectly stamped >=2 but missing import_source ---
	if (v >= 2 && !tableExists(db, "import_source")) {
		try {
			console.warn(
				"KOReader Importer: Detected corrupt index (missing import_source table). Attempting repair.",
			);
			db.run("BEGIN IMMEDIATE;");
			db.run(`
		      CREATE TABLE IF NOT EXISTS import_source(
		        source_path TEXT PRIMARY KEY,
		        last_processed_mtime INTEGER NOT NULL,
		        last_processed_size INTEGER NOT NULL,
		        newest_annotation_ts TEXT,
		        last_success_ts INTEGER,
		        last_error TEXT,
		        book_key TEXT,
		        md5 TEXT
		      );
		    `);
			db.run(
				"CREATE INDEX IF NOT EXISTS idx_import_source_book_key ON import_source(book_key);",
			);
			db.run(
				"CREATE INDEX IF NOT EXISTS idx_import_source_md5 ON import_source(md5);",
			);
			db.run("COMMIT;");
			console.log("KOReader Importer: Index repair successful.");
		} catch (e) {
			db.run("ROLLBACK;");
			console.error(
				"KOReader Importer: CRITICAL - Failed to repair the index database.",
				e,
			);
			throw e;
		}
	}

	// Guard: If DB is already modern, do nothing.
	if (v >= CURRENT_DB_VERSION) {
		return;
	}

	// Always ensure pragmas for older DBs being upgraded
	db.run("PRAGMA foreign_keys = ON;");
	try {
		db.run("PRAGMA journal_mode = WAL;");
	} catch {
		/* ignore in-memory */
	}

	if (v < 1) {
		// Bootstrap v1 schema (book table and index)
		db.run(`
      CREATE TABLE IF NOT EXISTS book(
        key        TEXT PRIMARY KEY,
        id         INTEGER,
        title      TEXT NOT NULL,
        authors    TEXT,
        vault_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_book_path ON book(vault_path);
    `);
		setUserVersion(db, 1);
	}

	if (v < 2) {
		db.run("BEGIN IMMEDIATE;");
		try {
			db.run(`
        CREATE TABLE IF NOT EXISTS import_source(
          source_path TEXT PRIMARY KEY,
          last_processed_mtime INTEGER NOT NULL,
          last_processed_size INTEGER NOT NULL,
          newest_annotation_ts TEXT,
          last_success_ts INTEGER,
          last_error TEXT,
          book_key TEXT,
          md5 TEXT
        );
      `);
			db.run(
				"CREATE INDEX IF NOT EXISTS idx_import_source_book_key ON import_source(book_key);",
			);
			db.run(
				"CREATE INDEX IF NOT EXISTS idx_import_source_md5 ON import_source(md5);",
			);
			setUserVersion(db, 2);
			db.run("COMMIT;");
		} catch (e) {
			db.run("ROLLBACK;");
			throw e;
		}
	}

	// v3: split book and book_instances, backfill, add constraints and GC
	if (v < CURRENT_DB_VERSION) {
		db.run("BEGIN IMMEDIATE;");
		try {
			// Create new conceptual table without path
			db.run(`
        CREATE TABLE IF NOT EXISTS book_new(
          key        TEXT PRIMARY KEY,
          id         INTEGER,
          title      TEXT NOT NULL,
          authors    TEXT
        );
      `);

			// Instances table (one row per file)
			db.run(`
        CREATE TABLE IF NOT EXISTS book_instances(
          book_key   TEXT NOT NULL REFERENCES book_new(key) ON DELETE CASCADE,
          vault_path TEXT NOT NULL,
          PRIMARY KEY (book_key, vault_path)
        );
      `);

			db.run(
				"CREATE UNIQUE INDEX IF NOT EXISTS uniq_book_instance_path ON book_instances(vault_path);",
			);
			db.run(
				"CREATE INDEX IF NOT EXISTS idx_instances_book_key ON book_instances(book_key);",
			);

			// Backfill conceptual rows from old book table
			db.run(
				"INSERT OR IGNORE INTO book_new(key,id,title,authors) SELECT key,id,title,authors FROM book;",
			);

			// Backfill instances for non-null paths if legacy 'book.vault_path' exists; ignore dup paths
			if (tableHasColumn(db, "book", "vault_path")) {
				db.run(
					"INSERT OR IGNORE INTO book_instances(book_key, vault_path) SELECT key, vault_path FROM book WHERE vault_path IS NOT NULL;",
				);
			}

			// Drop legacy index if present
			try {
				db.run("DROP INDEX IF EXISTS idx_book_path;");
			} catch {
				/* ignore */
			}

			// Replace old book table with new
			db.run("DROP TABLE book;");
			db.run("ALTER TABLE book_new RENAME TO book;");

			// GC trigger on instances delete
			db.run(`
        CREATE TRIGGER IF NOT EXISTS trg_gc_book AFTER DELETE ON book_instances
        BEGIN
          DELETE FROM book
          WHERE key = OLD.book_key
            AND NOT EXISTS (SELECT 1 FROM book_instances WHERE book_key = OLD.book_key);
        END;
      `);

			setUserVersion(db, CURRENT_DB_VERSION);
			db.run("COMMIT;");
		} catch (e) {
			db.run("ROLLBACK;");
			throw e;
		}
	}
}

async function backfillImportIndexJsonIfPresent(
	fs: FileSystemService,
	app: App,
	db: Database,
	log: LoggingService,
): Promise<void> {
	const jsonPath = fs.joinPluginDataPath("import-index.json");
	// Only run if file exists
	if (!(await fs.vaultExists(jsonPath))) return;

	try {
		const text = await app.vault.adapter.read(jsonPath);
		const parsed = JSON.parse(text) as Record<
			string,
			{ mtime: number; size: number; newestAnnotationTimestamp?: string }
		>;
		const entries = Object.entries(parsed);
		if (entries.length === 0) return;

		db.run("BEGIN IMMEDIATE;");
		try {
			const stmt = db.prepare(`
        INSERT INTO import_source(source_path, last_processed_mtime, last_processed_size, newest_annotation_ts, last_success_ts)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(source_path) DO UPDATE SET
          last_processed_mtime = excluded.last_processed_mtime,
          last_processed_size = excluded.last_processed_size,
          newest_annotation_ts = excluded.newest_annotation_ts,
          last_success_ts = excluded.last_success_ts
      `);
			const now = Date.now();
			for (const [source_path, e] of entries) {
				stmt.bind([
					source_path,
					e.mtime,
					e.size,
					e.newestAnnotationTimestamp ?? null,
					now,
				]);
				stmt.step();
				stmt.reset();
			}
			stmt.free();
			db.run("COMMIT;");
			// Archive JSON
			await app.vault.adapter.rename(jsonPath, jsonPath + ".bak");
			log
				.scoped("LocalIndexService")
				.info(
					`Migrated ${entries.length} import-index entries into SQLite (import_source).`,
				);
		} catch (e) {
			db.run("ROLLBACK;");
			throw e;
		}
	} catch (e) {
		log
			.scoped("LocalIndexService")
			.warn("Failed reading import-index.json for backfill.", e as any);
	}
}

interface DebouncedMetadataChangeHandler extends DebouncedFn {
	(file: TFile, data: string, cache: CachedMetadata): void;
}

export class LocalIndexService implements Disposable, SettingsObserver {
	private settings!: KoreaderHighlightImporterSettings;
	private readonly log!: ReturnType<LoggingService["scoped"]>;
	private idxDb: Database | null = null;
	private idxInitializing: Promise<void> | null = null;
	private concurrentDb: ConcurrentDatabase | null = null;

	private idxPath!: string;
	private pathCache!: LruCache<string, string[]>;
	private persistIndexDebounced!: Debouncer<[], void>;
	private debouncedHandleMetadataChange!: Debouncer<
		[TFile, string, CachedMetadata],
		void
	>;

	// Degraded-mode capability
	private indexState: "persistent" | "in_memory" | "unavailable" =
		"unavailable";

	// Async rebuild state when running in-memory
	private rebuildAbortController: AbortController | null = null;
	private rebuildNotice: Notice | null = null;
	private rebuildProgress: { current: number; total: number } | null = null;
	private processedDuringRebuild: Set<string> | null = null;
	private isRebuildingFlag = false;

	// Injected dependencies
	private readonly plugin!: KoreaderImporterPlugin;
	private readonly app!: App;
	private readonly fsService!: FileSystemService;
	private readonly cacheManager!: CacheManager;
	private readonly sqlJsManager!: SqlJsManager;
	private readonly loggingService!: LoggingService;
	private readonly frontmatterService!: FrontmatterService;
	private readonly capabilities!: CapabilityManager;

	constructor(
		plugin: KoreaderImporterPlugin,
		app: App,
		fsService: FileSystemService,
		cacheManager: CacheManager,
		sqlJsManager: SqlJsManager,
		loggingService: LoggingService,
		frontmatterService: FrontmatterService,
		capabilities?: CapabilityManager,
	) {
		this.plugin = plugin;
		this.app = app;
		this.fsService = fsService;
		this.cacheManager = cacheManager;
		this.sqlJsManager = sqlJsManager;
		this.loggingService = loggingService;
		this.frontmatterService = frontmatterService;
		// If not provided (e.g., older tests), construct a default CapabilityManager
		this.capabilities =
			capabilities ?? new CapabilityManager(app, fsService, loggingService);

		this.log = this.loggingService.scoped("LocalIndexService");
		this.settings = this.plugin.settings;

		// Caches and paths
		this.pathCache = this.cacheManager.createLru("db.path", 2000);
		this.idxPath = this.fsService.joinPluginDataPath("index.db");

		// Debounced helpers
		this.persistIndexDebounced = debounce(
			() => void this.flushIndex().catch(() => {}),
			1500,
			true,
		);
		this.debouncedHandleMetadataChange = debounce(
			(file: TFile, data: string, cache: CachedMetadata) =>
				void this._handleMetadataChange(file, data, cache),
			400,
			true,
		);
	}

	public async initialize(): Promise<void> {
		await this.ensureIndexReady();
		this.registerVaultEvents();
		if (this.indexState === "in_memory") {
			// kick off async rebuild to speed up duplicate detection
			void this.startBackgroundRebuild();
		}
	}

	public isIndexPersistent(): boolean {
		return this.indexState === "persistent";
	}

	private get isRebuilding(): boolean {
		return this.isRebuildingFlag;
	}

	public getIndexState(): "persistent" | "in_memory" | "unavailable" {
		return this.indexState;
	}

	/**
	 * Returns per-source processing state or null if not recorded.
	 */
	public async getImportSource(path: string): Promise<{
		source_path: string;
		last_processed_mtime: number;
		last_processed_size: number;
		newest_annotation_ts: string | null;
		last_success_ts: number | null;
		last_error: string | null;
		book_key: string | null;
		md5: string | null;
	} | null> {
		const db = await this.getConcurrentDb();
		return db.execute((database) => {
			const stmt = database.prepare(
				"SELECT source_path,last_processed_mtime,last_processed_size,newest_annotation_ts,last_success_ts,last_error,book_key,md5 FROM import_source WHERE source_path = ?",
			);
			try {
				stmt.bind([path]);
				if (!stmt.step()) return null;
				const row = stmt.getAsObject();
				return {
					source_path: row.source_path as string,
					last_processed_mtime: (row.last_processed_mtime as number) ?? 0,
					last_processed_size: (row.last_processed_size as number) ?? 0,
					newest_annotation_ts: (row.newest_annotation_ts as string) ?? null,
					last_success_ts: (row.last_success_ts as number) ?? null,
					last_error: (row.last_error as string) ?? null,
					book_key: (row.book_key as string) ?? null,
					md5: (row.md5 as string) ?? null,
				};
			} finally {
				stmt.free();
			}
		});
	}

	/**
	 * Determines whether a metadata.lua source should be processed based on
	 * stored per-source state (mtime/size and newest annotation timestamp).
	 */
	public async shouldProcessSource(
		path: string,
		stats: { mtime: number; size: number },
		newestAnnotationTs: string | null,
	): Promise<boolean> {
		const existing = await this.getImportSource(path);
		if (!existing) return true;
		if (
			existing.last_processed_mtime !== stats.mtime ||
			existing.last_processed_size !== stats.size
		) {
			return true;
		}
		if (newestAnnotationTs) {
			const prev = existing.newest_annotation_ts ?? "";
			if (newestAnnotationTs > prev) return true;
		}
		return false;
	}

	public async recordImportSuccess(params: {
		path: string;
		mtime: number;
		size: number;
		newestAnnotationTs: string | null;
		bookKey?: string | null;
		md5?: string | null;
		vaultPath?: string | null;
	}): Promise<void> {
		const db = await this.getConcurrentDb();
		await db.writeTx((database) => {
			// Upsert per-source row
			database.run(
				`INSERT INTO import_source(source_path,last_processed_mtime,last_processed_size,newest_annotation_ts,last_success_ts,last_error,book_key,md5)
				 VALUES(?,?,?,?,?,?,?,?)
				 ON CONFLICT(source_path) DO UPDATE SET
				  last_processed_mtime=excluded.last_processed_mtime,
				  last_processed_size=excluded.last_processed_size,
				  newest_annotation_ts=excluded.newest_annotation_ts,
				  last_success_ts=excluded.last_success_ts,
				  last_error=NULL,
				  book_key=COALESCE(excluded.book_key, import_source.book_key),
				  md5=COALESCE(excluded.md5, import_source.md5)
				 `,
				[
					params.path,
					params.mtime,
					params.size,
					params.newestAnnotationTs ?? null,
					Date.now(),
					null,
					params.bookKey ?? null,
					params.md5 ?? null,
				],
			);

			// Best-effort: ensure conceptual row then upsert instance mapping
			if (params.vaultPath && params.bookKey) {
				// Create a minimal book row if not exists
				database.run(`INSERT OR IGNORE INTO book(key) VALUES (?)`, [
					params.bookKey,
				]);
				// Upsert instance by path
				database.run(
					`INSERT INTO book_instances(book_key, vault_path) VALUES(?,?)
					 ON CONFLICT(vault_path) DO UPDATE SET book_key = excluded.book_key`,
					[params.bookKey, params.vaultPath],
				);
			}
			return undefined;
		});
		this.persistIndexDebounced();
	}

	public async recordImportFailure(
		path: string,
		error: unknown,
	): Promise<void> {
		const db = await this.getConcurrentDb();
		await db.writeTx((database) => {
			const message =
				typeof error === "string"
					? error
					: ((error as any)?.message ?? JSON.stringify(error ?? "error"));
			database.run(
				`INSERT INTO import_source(source_path,last_processed_mtime,last_processed_size,last_error)
				 VALUES(?,?,?,?)
				 ON CONFLICT(source_path) DO UPDATE SET last_error = excluded.last_error, last_success_ts = NULL`,
				[path, 0, 0, message],
			);
			return undefined;
		});
		this.persistIndexDebounced();
	}

	public async deleteImportSource(path: string): Promise<void> {
		const db = await this.getConcurrentDb();
		const changed = await db.writeTx((database) => {
			database.run("DELETE FROM import_source WHERE source_path = ?", [path]);
			return database.getRowsModified() > 0;
		});
		if (changed) {
			this.persistIndexDebounced();
		}
	}

	/**
	 * Clears all per-source state so next import reprocesses everything.
	 */
	public async clearImportSource(): Promise<void> {
		const db = await this.getConcurrentDb();
		await db.writeTx((database) => {
			database.run("DELETE FROM import_source");
			return undefined;
		});
		this.persistIndexDebounced();
	}

	/**
	 * Finds existing book files in the index by book key.
	 * Returns cached paths if available, otherwise queries the index.
	 * @param bookKey - Unique identifier for the book
	 * @returns Array of file paths associated with the book key
	 */
	public async findExistingBookFiles(bookKey: string): Promise<string[]> {
		const cached = this.pathCache.get(bookKey);
		if (cached) return cached;

		const db = await this.getConcurrentDb();
		return db.execute((database) => {
			const stmt = database.prepare(
				"SELECT vault_path FROM book_instances WHERE book_key = ?",
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
		});
	}

	/**
	 * Upserts a book entry in the index.
	 * If the book key exists, updates its properties; otherwise, inserts a new entry.
	 * @param id - Optional unique identifier for the book
	 * @param key - Unique key for the book (author::title)
	 * @param title - Book title
	 * @param authors - Comma-separated list of authors
	 * @param vaultPath - Optional path in the vault where the book file is stored
	 */
	public async upsertBook(
		id: number | null,
		key: string,
		title: string,
		authors: string,
		vaultPath?: string,
	): Promise<void> {
		const db = await this.getConcurrentDb();
		await db.writeTx((database) => {
			// Upsert conceptual book
			database.run(
				`INSERT INTO book(key,id,title,authors) VALUES(?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           id=COALESCE(excluded.id, book.id),
           title=excluded.title,
           authors=excluded.authors`,
				[key, id, title, authors],
			);
			// Upsert instance if provided
			if (vaultPath) {
				database.run(
					`INSERT INTO book_instances(book_key, vault_path) VALUES(?,?)
           ON CONFLICT(vault_path) DO UPDATE SET book_key = excluded.book_key`,
					[key, vaultPath],
				);
			}
			return undefined;
		});
		this.pathCache.delete(key);
		this.persistIndexDebounced();
	}

	public onSettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
	): void {
		this.settings = newSettings;
	}

	/**
	 * Look up the conceptual book key for a given vault file path.
	 */
	public async findKeyByVaultPath(vaultPath: string): Promise<string | null> {
		const row = await this.queryOne<{ book_key: string }>(
			"SELECT book_key FROM book_instances WHERE vault_path = ?",
			[vaultPath],
		);
		return row?.book_key ?? null;
	}

	/**
	 * Returns the most recently processed device metadata path for a given book.
	 * The returned string is the stored source path with any leading drive/root trimmed,
	 * suitable to be joined with the current mount point.
	 */
	public async latestSourceForBook(bookKey: string): Promise<string | null> {
		const db = await this.getConcurrentDb();
		const raw = await db.execute((database) => {
			const stmt = database.prepare(
				`SELECT source_path, newest_annotation_ts, last_success_ts, last_processed_mtime
         FROM import_source
         WHERE book_key = ? AND source_path IS NOT NULL
         ORDER BY COALESCE(newest_annotation_ts, '') DESC,
                  COALESCE(last_success_ts, 0) DESC,
                  COALESCE(last_processed_mtime, 0) DESC
         LIMIT 1`,
			);
			try {
				stmt.bind([bookKey]);
				if (!stmt.step()) return null as string | null;
				const row = stmt.getAsObject();
				return (row.source_path as string) ?? null;
			} finally {
				stmt.free();
			}
		});
		if (!raw) return null;
		// Normalize to be relative to mount root if an absolute path was stored
		return this.stripRootFromDevicePath(raw);
	}

	/**
	 * Strips a Windows drive (e.g., "E:\\") or leading slash from a stored device path
	 * to make it relative to the mount root.
	 */
	private stripRootFromDevicePath(p: string): string {
		// Windows drive like "E:\\" or "E:/"
		const win = p.replace(/^[A-Za-z]:[\\/]+/, "");
		if (win !== p) return win;
		// POSIX root
		return p.replace(/^\/+/, "");
	}

	// Centralized SQL helpers to reduce boilerplate
	private async queryOne<T>(sql: string, params: any[]): Promise<T | null> {
		const db = await this.getConcurrentDb();
		return db.execute((database) => {
			const stmt = database.prepare(sql);
			try {
				stmt.bind(params);
				return stmt.step() ? (stmt.getAsObject() as T) : null;
			} finally {
				stmt.free();
			}
		});
	}

	private async ensureIndexReady(): Promise<void> {
		if (this.idxDb) return;
		if (this.idxInitializing) return this.idxInitializing;

		this.idxInitializing = (async () => {
			// If idxPath is invalid (e.g., could not be determined), skip directly to in-memory mode.
			if (!this.idxPath) {
				this.log.info(
					"Persistent index path not available. Initializing in-memory DB.",
				);
				await this.initializeInMemoryDb();
				this.idxInitializing = null;
				return;
			}

			// Ask capability manager whether persistence is likely before attempting
			const likely = await this.capabilities.ensure("indexPersistenceLikely", {
				notifyOnce: true,
			});
			if (!likely) {
				await this.initializeInMemoryDb();
				this.indexState = "in_memory";
				this.idxInitializing = null;
				return;
			}

			try {
				// Open or create persistent DB
				const db = await this.sqlJsManager.openDatabase(this.idxPath, {
					schemaSql: INDEX_DB_SCHEMA,
					validate: true,
				});
				this.idxDb = db;
				// Run migrations and one-time backfill
				migrateDb(db);
				if (getUserVersion(db) >= 2) {
					await backfillImportIndexJsonIfPresent(
						this.fsService,
						this.app,
						db,
						this.loggingService,
					);
				}
				this.indexState = "persistent";
				// Ensure the brand-new DB is flushed at least once to disk
				await this.sqlJsManager.persistDatabase(this.idxPath);
				this.capabilities.reportOutcome("indexPersistenceLikely", true);
			} catch (error) {
				this.log.warn(
					"Persistent index unavailable; falling back to in-memory...",
					error,
				);
				this.capabilities.reportOutcome(
					"indexPersistenceLikely",
					false,
					error as any,
				);
				await this.initializeInMemoryDb();
			} finally {
				this.idxInitializing = null;
			}
		})();
		return this.idxInitializing;
	}

	// Helper to initialize in-memory DB with schema and state
	private async initializeInMemoryDb(): Promise<void> {
		try {
			const memDb = await this.sqlJsManager.createInMemoryDatabase();
			this.idxDb = memDb;
			this.sqlJsManager.applySchema(memDb, INDEX_DB_SCHEMA);
			// Stamp fresh in-memory DBs with the current schema version to avoid running upgrade migrations
			memDb.run(`PRAGMA user_version = ${CURRENT_DB_VERSION};`);
			// Ensure schema migrations are applied to in-memory DB as well
			migrateDb(memDb);
			this.indexState = "in_memory";
			this.concurrentDb = new ConcurrentDatabase(
				async () => {
					if (!this.idxDb) throw new Error("Index DB not initialized");
					return this.idxDb;
				},
				undefined, // in-memory persistence handled separately
			);
		} catch (memErr) {
			this.log.error(
				"Failed to initialize in-memory index database.",
				memErr as any,
			);
			this.idxDb = null;
			this.concurrentDb = null;
			this.indexState = "unavailable";
		}
	}

	/**
	 * Starts a background rebuild of the in-memory index by scanning the highlights
	 * folder and inserting book rows using the ParallelIndexProcessor.
	 */
	private async startBackgroundRebuild(): Promise<void> {
		if (this.isRebuilding) return;
		this.isRebuildingFlag = true;
		this.rebuildAbortController = new AbortController();
		this.rebuildProgress = { current: 0, total: 0 };

		try {
			this.rebuildNotice = new Notice("📚 Building temporary index…", 0);

			// Resolve highlights folder root
			const folderPath = this.settings.highlightsFolder ?? "";
			const root = this.app.vault.getAbstractFileByPath(folderPath);
			if (!(root instanceof TFolder)) {
				this.log.warn(
					`Cannot rebuild index: highlights folder not found or not a folder: '${folderPath}'`,
				);
				this.finishRebuildNotice(
					true,
					"⚠️ Index rebuild failed: missing folder",
				);
				return;
			}

			// Collect markdown files upfront to give a stable total count
			const { files } = await this.fsService.getFilesInFolder(root, {
				extensions: ["md"],
				recursive: true,
			});
			this.rebuildProgress.total = files.length;
			this.updateRebuildNotice();

			// Use the new parallel processor
			const db = await this.getConcurrentDb();
			const processor = new ParallelIndexProcessor(
				this.frontmatterService,
				db,
				this.loggingService,
				{
					workers: Math.min(6, Math.max(2, navigator.hardwareConcurrency || 4)),
					batchSize: 64,
				},
			);

			const onProgress = (current: number, total: number) => {
				if (!this.rebuildProgress) return;
				this.rebuildProgress.current = current;
				// Update occasionally to avoid UI thrash
				if (current % 5 === 0 || current === total) this.updateRebuildNotice();
			};

			const result = await processor.processFiles(
				files,
				onProgress,
				this.rebuildAbortController.signal,
			);

			if (this.rebuildAbortController.signal.aborted) {
				this.finishRebuildNotice(false, "⏸ Index rebuild cancelled");
				return;
			}

			if (result.errors.length > 0) {
				this.log.warn(
					`Index rebuild completed with ${result.errors.length} errors.`,
				);
			}

			this.finishRebuildNotice(false, "✅ Temporary index ready");
			this.log.info("In-memory index rebuild completed.");
		} catch (e: unknown) {
			if (e instanceof DOMException && e.name === "AbortError") {
				this.finishRebuildNotice(false, "⏸ Index rebuild cancelled");
				this.log.warn("Index rebuild cancelled by user.");
			} else {
				this.finishRebuildNotice(
					true,
					"⚠️ Rebuild failed. Using slower duplicate detection",
				);
				this.log.error("Index rebuild failed", e);
			}
		} finally {
			this.rebuildAbortController = null;
			this.rebuildProgress = null;
			this.isRebuildingFlag = false;
		}
	}

	private updateRebuildNotice(): void {
		if (!this.rebuildNotice || !this.rebuildProgress) return;
		const { current, total } = this.rebuildProgress;
		const pct = total === 0 ? 100 : Math.round((current / total) * 100);
		this.rebuildNotice.setMessage(
			`📚 Building index: ${current}/${total} files (${pct}%)`,
		);
	}

	private finishRebuildNotice(isError: boolean, message: string): void {
		try {
			this.rebuildNotice?.hide();
		} catch {
			// ignore
		}
		this.rebuildNotice = null;
		// Show a short completion notice
		new Notice(message, isError ? 5000 : 3000);
	}

	public async flushIndex(): Promise<void> {
		this.persistIndexDebounced.cancel();
		if (this.isIndexPersistent()) {
			try {
				await this.sqlJsManager.persistDatabase(this.idxPath);
			} catch (e) {
				this.log.error(`Failed to save index to ${this.idxPath}`, e as Error);
				new Notice(
					"KOReader Importer: Failed to save index. Changes may be lost.",
					8000,
				);
			}
		}
	}

	/**
	 * Completely deletes the persistent index database file.
	 * This is a destructive operation intended for a full reset.
	 */
	public async deleteIndexFile(): Promise<void> {
		this.log.warn("Deleting persistent index database file.");

		// 1. Ensure any pending writes are flushed and the DB is closed.
		await this.dispose();

		// 2. Reset in-memory state immediately
		this.idxDb = null;
		this.concurrentDb = null;
		this.pathCache.clear();
		this.indexState = "unavailable";

		// 3. Physically delete the file
		try {
			// Use Vault adapter to delete the file physically (normalize path for adapter)
			const normalizedPath = FileSystemService.toVaultPath(this.idxPath);
			if (await this.fsService.vaultExists(normalizedPath)) {
				await this.app.vault.adapter.remove(normalizedPath);
				this.log.info("Successfully deleted index file.");
			}
		} catch (error) {
			this.log.error(
				`Failed to delete index file at ${this.idxPath}`,
				error as Error,
			);
			// proceed anyway
		}
	}

	public async dispose(): Promise<void> {
		await this.flushIndex();
		this.sqlJsManager.closeDatabase(this.idxPath);
	}

	private registerVaultEvents(): void {
		this.plugin.registerEvent(
			this.app.vault.on("rename", this.handleRename.bind(this)),
		);
		this.plugin.registerEvent(
			this.app.vault.on("delete", this.handleDelete.bind(this)),
		);
		// Listen to metadata changes to keep index in sync when frontmatter edits change key fields
		this.plugin.registerEvent(
			this.app.metadataCache.on("changed", this.debouncedHandleMetadataChange),
		);
	}

	private async handleRename(
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> {
		this.cacheManager.clear("db.path");

		const db = await this.getConcurrentDb();
		await db.writeTx((database) => {
			if (file instanceof TFolder) {
				database.run(
					`UPDATE book_instances SET vault_path = REPLACE(vault_path, ?, ?) WHERE vault_path LIKE ?`,
					[`${oldPath}/`, `${(file as TFolder).path}/`, `${oldPath}/%`],
				);
			} else if (file instanceof TFile) {
				database.run(
					`UPDATE book_instances SET vault_path = ? WHERE vault_path = ?`,
					[(file as TFile).path, oldPath],
				);
			}
			return undefined;
		});
		this.persistIndexDebounced();
	}

	private async handleDelete(file: TAbstractFile): Promise<void> {
		this.cacheManager.clear("db.path");
		const pathToDelete = file.path;

		const db = await this.getConcurrentDb();
		const changed = await db.writeTx((database) => {
			if (file instanceof TFolder) {
				database.run(`DELETE FROM book_instances WHERE vault_path LIKE ?`, [
					`${pathToDelete}/%`,
				]);
			} else if (file instanceof TFile) {
				database.run(`DELETE FROM book_instances WHERE vault_path = ?`, [
					pathToDelete,
				]);
			}
			return database.getRowsModified() > 0;
		});
		if (changed) {
			this.persistIndexDebounced();
		}
	}

	private async _handleMetadataChange(
		file: TFile,
		_data: string,
		_cache: CachedMetadata,
	): Promise<void> {
		try {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			if (!this.settings.highlightsFolder) return;
			if (!file.path.startsWith(this.settings.highlightsFolder)) return;

			// Do async/expensive work outside the critical section
			const metadata = await this.frontmatterService.extractMetadata(file);

			const db = await this.getConcurrentDb();
			const result = await db.writeTx((database) => {
				// Existing mapping for this path
				let oldKey: string | null = null;
				const sel = database.prepare(
					"SELECT book_key FROM book_instances WHERE vault_path = ?",
				);
				try {
					sel.bind([file.path]);
					if (sel.step()) {
						const row = sel.getAsObject();
						oldKey = (row.book_key as string) ?? null;
					}
				} finally {
					sel.free();
				}

				if (!metadata) {
					if (oldKey) {
						database.run("DELETE FROM book_instances WHERE vault_path = ?", [
							file.path,
						]);
						return { changed: true, oldKey, newKey: null as string | null };
					}
					return {
						changed: false,
						oldKey: null as string | null,
						newKey: null as string | null,
					};
				}

				// Upsert conceptual book
				database.run(
					`INSERT INTO book(key,id,title,authors) VALUES(?,?,?,?)
					 ON CONFLICT(key) DO UPDATE SET
					   id=COALESCE(excluded.id, book.id),
					   title=excluded.title,
					   authors=excluded.authors`,
					[metadata.key, null, metadata.title, metadata.authors],
				);

				if (oldKey && oldKey !== metadata.key) {
					// Reassign mapping
					database.run(
						"UPDATE book_instances SET book_key = ? WHERE vault_path = ?",
						[metadata.key, file.path],
					);
				} else {
					// Ensure instance exists and points to new key
					database.run(
						`INSERT INTO book_instances(book_key, vault_path) VALUES(?,?)
						 ON CONFLICT(vault_path) DO UPDATE SET book_key = excluded.book_key`,
						[metadata.key, file.path],
					);
				}

				return { changed: true, oldKey, newKey: metadata.key as string };
			});

			if (result.changed) {
				if (result.oldKey) this.pathCache.delete(result.oldKey);
				if (result.newKey) this.pathCache.delete(result.newKey);
				this.persistIndexDebounced();
			}
		} catch (e) {
			this.log.warn("Failed handling metadata change", e);
		}
	}

	private async getConcurrentDb(): Promise<ConcurrentDatabase> {
		if (this.concurrentDb) return this.concurrentDb;

		// Ensure index persistent db is opened and cached
		if (!this.idxDb) {
			await this.ensureIndexReady();
		}

		// If we are in-memory and already have a ConcurrentDatabase over the in-memory DB, reuse it
		if (this.indexState === "in_memory" && this.concurrentDb) {
			return this.concurrentDb;
		}

		// If we are in-memory but concurrentDb wasn't set (defensive), create it around idxDb
		if (this.indexState === "in_memory" && this.idxDb && !this.concurrentDb) {
			this.concurrentDb = new ConcurrentDatabase(async () => this.idxDb!);
			return this.concurrentDb;
		}

		// Persistent path
		const dbPath = this.idxPath;
		this.concurrentDb = new ConcurrentDatabase(
			async () => {
				// openDatabase will return cached DB
				const db = await this.sqlJsManager.openDatabase(dbPath, {
					schemaSql: INDEX_DB_SCHEMA,
					validate: true,
				});
				this.idxDb = db;
				return db;
			},
			(isDirty: boolean) => this.sqlJsManager.setDirty(dbPath, isDirty),
		);
		return this.concurrentDb;
	}
}
