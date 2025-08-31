import type { Database, Statement } from "sql.js";
import { Validators, validateAndExtract } from "src/lib/core/validationUtils";
import { formatError } from "src/lib/errors/types";

type SqlValue = string | number | null | Uint8Array;

// Ordered migrations array - single source of truth for schema evolution
export const MIGRATIONS: { version: number; sql: string }[] = [
	// v1 boot (legacy schema)
	{
		version: 1,
		sql: `
    CREATE TABLE IF NOT EXISTS book(
      key        TEXT PRIMARY KEY,
      id         INTEGER,
      title      TEXT NOT NULL,
      authors    TEXT,
      vault_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_book_path ON book(vault_path);
  `,
	},
	// v2 import_source table
	{
		version: 2,
		sql: `
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
    CREATE INDEX IF NOT EXISTS idx_import_source_book_key ON import_source(book_key);
    CREATE INDEX IF NOT EXISTS idx_import_source_md5 ON import_source(md5);
  `,
	},
	// v3 split instances + GC trigger
	{
		version: 3,
		sql: `
    CREATE TABLE IF NOT EXISTS book_new(
      key        TEXT PRIMARY KEY,
      id         INTEGER,
      title      TEXT NOT NULL,
      authors    TEXT
    );
    CREATE TABLE IF NOT EXISTS book_instances(
      book_key   TEXT NOT NULL REFERENCES book_new(key) ON DELETE CASCADE,
      vault_path TEXT NOT NULL,
      PRIMARY KEY (book_key, vault_path)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_book_instance_path ON book_instances(vault_path);
    CREATE INDEX IF NOT EXISTS idx_instances_book_key ON book_instances(book_key);
    INSERT OR IGNORE INTO book_new(key,id,title,authors) SELECT key,id,title,authors FROM book;
    -- if old 'book.vault_path' exists, backfill instances:
    -- (safe if column missing; ignore errors in migrateDb wrapper)
    INSERT OR IGNORE INTO book_instances(book_key, vault_path)
      SELECT key, vault_path FROM book WHERE vault_path IS NOT NULL;
    DROP INDEX IF EXISTS idx_book_path;
    DROP TABLE IF EXISTS book;
    ALTER TABLE book_new RENAME TO book;
    CREATE TRIGGER IF NOT EXISTS trg_gc_book AFTER DELETE ON book_instances
    BEGIN
      DELETE FROM book
      WHERE key = OLD.book_key
        AND NOT EXISTS (SELECT 1 FROM book_instances WHERE book_key = OLD.book_key);
    END;
  `,
	},
];

// Derive DDL from migrations - ensures no drift between DDL and migrations
export const CURRENT_DB_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
export const DDL = MIGRATIONS.map((m) => m.sql).join("\n");

// SQL used by BookRepository
export const SQL_BOOK = {
	UPSERT_BOOK: `
    INSERT INTO book(key,id,title,authors) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET
      id=COALESCE(excluded.id, book.id),
      title=excluded.title,
      authors=excluded.authors
  `,
	INSERT_BOOK_IF_NOT_EXISTS: `INSERT OR IGNORE INTO book(key) VALUES (?)`,
	UPSERT_INSTANCE: `
    INSERT INTO book_instances(book_key, vault_path) VALUES(?,?)
    ON CONFLICT(vault_path) DO UPDATE SET book_key = excluded.book_key
  `,
	DELETE_INSTANCE_BY_PATH: `DELETE FROM book_instances WHERE vault_path = ?`,
	SELECT_BOOK_KEY_BY_PATH: `SELECT book_key FROM book_instances WHERE vault_path = ?`,
	SELECT_PATHS_BY_BOOK_KEY: `SELECT vault_path FROM book_instances WHERE book_key = ?`,
	RENAME_FOLDER: `
    UPDATE book_instances
    SET vault_path = REPLACE(vault_path, ?, ?)
    WHERE vault_path LIKE ?`,
	RENAME_FILE: `UPDATE book_instances SET vault_path = ? WHERE vault_path = ?`,
};

// SQL used by ImportSourceRepository
export const SQL_SOURCE = {
	GET_BY_PATH: `
    SELECT source_path,last_processed_mtime,last_processed_size,newest_annotation_ts,last_success_ts,last_error,book_key,md5
    FROM import_source WHERE source_path = ?`,
	UPSERT_SUCCESS: `
    INSERT INTO import_source(source_path,last_processed_mtime,last_processed_size,newest_annotation_ts,last_success_ts,last_error,book_key,md5)
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
	UPSERT_FAILURE: `
    INSERT INTO import_source(source_path,last_processed_mtime,last_processed_size,last_error)
    VALUES(?,?,?,?)
    ON CONFLICT(source_path) DO UPDATE SET last_error = excluded.last_error, last_success_ts = NULL
  `,
	DELETE_BY_PATH: `DELETE FROM import_source WHERE source_path = ?`,
	CLEAR_ALL: `DELETE FROM import_source`,
	LATEST_SOURCE_FOR_BOOK: `
    SELECT source_path
    FROM import_source
    WHERE book_key = ? AND source_path IS NOT NULL
    ORDER BY COALESCE(newest_annotation_ts, '') DESC,
             COALESCE(last_success_ts, 0) DESC,
             COALESCE(last_processed_mtime, 0) DESC
    LIMIT 1`,
};

// Define parameter types for each SQL query
type UpsertBookParams = [string, number | null, string, string];
type InsertBookIfNotExistsParams = [string];
type UpsertInstanceParams = [string, string];
type DeleteInstanceByPathParams = [string];
type SelectBookKeyByPathParams = [string];
type SelectPathsByBookKeyParams = [string];
type RenameFolderParams = [string, string, string];
type RenameFileParams = [string, string];
type GetImportSourceByPathParams = [string];
type UpsertImportSourceSuccessParams = [
	string,
	number,
	number,
	string | null,
	number,
	null,
	string | null,
	string | null,
];
type UpsertImportSourceFailureParams = [string, number, number, string];
type DeleteImportSourceByPathParams = [string];
type ClearAllImportSourcesParams = [];
type LatestSourceForBookParams = [string];

// Type-safe query builders
export const QueryBuilders = {
	selectBookKeyByPath: (vaultPath: string) => ({
		sql: SQL_BOOK.SELECT_BOOK_KEY_BY_PATH,
		params: [vaultPath] as SelectBookKeyByPathParams,
	}),

	upsertBook: (
		key: string,
		id: number | null,
		title: string,
		authors: string,
	) => ({
		sql: SQL_BOOK.UPSERT_BOOK,
		params: [key, id, title, authors] as UpsertBookParams,
	}),

	selectPathsByBookKey: (bookKey: string) => ({
		sql: SQL_BOOK.SELECT_PATHS_BY_BOOK_KEY,
		params: [bookKey] as SelectPathsByBookKeyParams,
	}),

	upsertInstance: (bookKey: string, vaultPath: string) => ({
		sql: SQL_BOOK.UPSERT_INSTANCE,
		params: [bookKey, vaultPath] as UpsertInstanceParams,
	}),

	insertBookIfNotExists: (key: string) => ({
		sql: SQL_BOOK.INSERT_BOOK_IF_NOT_EXISTS,
		params: [key] as InsertBookIfNotExistsParams,
	}),

	deleteInstanceByPath: (vaultPath: string) => ({
		sql: SQL_BOOK.DELETE_INSTANCE_BY_PATH,
		params: [vaultPath] as DeleteInstanceByPathParams,
	}),

	renameFolder: (oldPath: string, newPath: string, likePattern: string) => ({
		sql: SQL_BOOK.RENAME_FOLDER,
		params: [oldPath, newPath, likePattern] as RenameFolderParams,
	}),

	renameFile: (newPath: string, oldPath: string) => ({
		sql: SQL_BOOK.RENAME_FILE,
		params: [newPath, oldPath] as RenameFileParams,
	}),

	getImportSourceByPath: (sourcePath: string) => ({
		sql: SQL_SOURCE.GET_BY_PATH,
		params: [sourcePath] as GetImportSourceByPathParams,
	}),

	upsertImportSourceSuccess: (
		sourcePath: string,
		mtime: number,
		size: number,
		newestAnnotationTs: string | null,
		lastSuccessTs: number,
		bookKey: string | null,
		md5: string | null,
	) => ({
		sql: SQL_SOURCE.UPSERT_SUCCESS,
		params: [
			sourcePath,
			mtime,
			size,
			newestAnnotationTs,
			lastSuccessTs,
			null,
			bookKey,
			md5,
		] as UpsertImportSourceSuccessParams,
	}),

	upsertImportSourceFailure: (
		sourcePath: string,
		mtime: number,
		size: number,
		error: string,
	) => ({
		sql: SQL_SOURCE.UPSERT_FAILURE,
		params: [sourcePath, mtime, size, error] as UpsertImportSourceFailureParams,
	}),

	deleteImportSourceByPath: (sourcePath: string) => ({
		sql: SQL_SOURCE.DELETE_BY_PATH,
		params: [sourcePath] as DeleteImportSourceByPathParams,
	}),

	clearAllImportSources: () => ({
		sql: SQL_SOURCE.CLEAR_ALL,
		params: [] as ClearAllImportSourcesParams,
	}),

	latestSourceForBook: (bookKey: string) => ({
		sql: SQL_SOURCE.LATEST_SOURCE_FOR_BOOK,
		params: [bookKey] as LatestSourceForBookParams,
	}),
} as const;

/**
 * Executes a write query (INSERT, UPDATE, DELETE) with type-safe parameters.
 */
export function executeWrite(
	db: Database,
	query: { sql: string; params: readonly unknown[] },
): void {
	const stmt = db.prepare(query.sql);
	try {
		stmt.bind([...query.params] as SqlValue[]);
		stmt.step();
	} finally {
		stmt.free();
	}
}

// Type-safe statement executor
export function executeTyped<T>(
	db: Database,
	query: { sql: string; params: readonly unknown[] },
	mapper: (row: Record<string, unknown>) => T,
): T[] {
	const stmt: Statement = db.prepare(query.sql);
	const results: T[] = [];
	try {
		stmt.bind([...query.params] as SqlValue[]);
		while (stmt.step()) {
			results.push(mapper(stmt.getAsObject()));
		}
		return results;
	} finally {
		stmt.free();
	}
}

// Row mappers
export const RowMappers = {
	bookKey: (row: Record<string, unknown>) => row.book_key as string,

	vaultPath: (row: Record<string, unknown>) => row.vault_path as string,

	sourcePath: (row: Record<string, unknown>) => row.source_path as string,

	importSource: (row: Record<string, unknown>) => {
		return {
			source_path: validateAndExtract(
				row,
				"source_path",
				Validators.isString,
				"",
			),
			last_processed_mtime: validateAndExtract(
				row,
				"last_processed_mtime",
				Validators.isNumber,
				0,
			),
			last_processed_size: validateAndExtract(
				row,
				"last_processed_size",
				Validators.isNumber,
				0,
			),
			newest_annotation_ts: validateAndExtract(
				row,
				"newest_annotation_ts",
				Validators.isString,
				null,
			),
			last_success_ts: validateAndExtract(
				row,
				"last_success_ts",
				Validators.isNumber,
				null,
			),
			last_error: validateAndExtract(
				row,
				"last_error",
				Validators.isString,
				null,
			),
			book_key: validateAndExtract(row, "book_key", Validators.isString, null),
			md5: validateAndExtract(row, "md5", Validators.isString, null),
		};
	},
} as const;

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

// Minimal logger interface used for optional logging in migrateDb
type LoggerLike = {
	info: (message: string, ...args: unknown[]) => void;
	warn: (message: string, ...args: unknown[]) => void;
	error: (message: string, ...args: unknown[]) => void;
};

// Migration entrypoint - applies ordered migrations based on PRAGMA user_version
export function migrateDb(db: Database, log?: LoggerLike): void {
	const start = getUserVersion(db);

	// --- Remediation for databases incorrectly stamped >=2 but missing import_source ---
	if (start >= 2 && !tableExists(db, "import_source")) {
		try {
			if (log)
				log.warn(
					"KOReader Importer: Detected corrupt index (missing import_source table). Attempting repair.",
				);
			else
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
			if (log) log.info("KOReader Importer: Index repair successful.");
			else console.log("KOReader Importer: Index repair successful.");
		} catch (e) {
			db.run("ROLLBACK;");
			if (log)
				log.error(
					"KOReader Importer: CRITICAL - Failed to repair the index database.",
					formatError(e),
				);
			else
				console.error(
					"KOReader Importer: CRITICAL - Failed to repair the index database.",
					formatError(e),
				);
			throw e;
		}
	}

	// Apply migrations in order
	for (const m of MIGRATIONS) {
		const v = getUserVersion(db);
		if (v >= m.version) continue;

		// Always ensure pragmas for older DBs being upgraded
		if (m.version >= 1) {
			db.run("PRAGMA foreign_keys = ON;");
			try {
				db.run("PRAGMA journal_mode = WAL;");
			} catch {
				/* ignore in-memory */
			}
		}

		db.run("BEGIN IMMEDIATE;");
		try {
			db.exec(m.sql);
			setUserVersion(db, m.version);
			db.run("COMMIT;");
			log?.info?.(`Applied migration v${m.version}`);
		} catch (e) {
			db.run("ROLLBACK;");
			log?.error?.(`Migration to v${m.version} failed`, formatError(e));
			throw e;
		}
	}
}
