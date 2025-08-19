import type { Database } from "sql.js";
import { INDEX_DB_VERSION } from "src/constants";

export const CURRENT_DB_VERSION = INDEX_DB_VERSION;

export const DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS book(
  key        TEXT PRIMARY KEY,
  id         INTEGER,
  title      TEXT NOT NULL,
  authors    TEXT
);

CREATE TABLE IF NOT EXISTS book_instances(
  book_key   TEXT NOT NULL REFERENCES book(key) ON DELETE CASCADE,
  vault_path TEXT NOT NULL,
  PRIMARY KEY (book_key, vault_path)
);

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

CREATE UNIQUE INDEX IF NOT EXISTS uniq_book_instance_path ON book_instances(vault_path);
CREATE INDEX IF NOT EXISTS idx_instances_book_key ON book_instances(book_key);
CREATE INDEX IF NOT EXISTS idx_import_source_book_key ON import_source(book_key);
CREATE INDEX IF NOT EXISTS idx_import_source_md5 ON import_source(md5);

CREATE TRIGGER IF NOT EXISTS trg_gc_book AFTER DELETE ON book_instances
BEGIN
  DELETE FROM book
  WHERE key = OLD.book_key
    AND NOT EXISTS (SELECT 1 FROM book_instances WHERE book_key = OLD.book_key);
END;
`;

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

// Helper functions for migration
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

// Minimal logger interface used for optional logging in migrateDb
type LoggerLike = {
	info: (...args: any[]) => void;
	warn: (...args: any[]) => void;
	error: (...args: any[]) => void;
};

// Migration entrypoint (moved from LocalIndexService)
export function migrateDb(db: Database, log?: LoggerLike): void {
	const v = getUserVersion(db);

	// --- Remediation for databases incorrectly stamped >=2 but missing import_source ---
	if (v >= 2 && !tableExists(db, "import_source")) {
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
					e as unknown,
				);
			else
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
