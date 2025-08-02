import path from "node:path";
import {
	type App,
	debounce,
	normalizePath,
	Notice,
	type TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import type { Database } from "sql.js";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { CacheManager } from "src/utils/cache/CacheManager";
import type { LruCache } from "src/utils/cache/LruCache";
import { normalizeFileNamePiece } from "src/utils/formatUtils";
import type {
	DebouncedFn,
	Disposable,
	DocProps,
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "../../types";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { SqlJsManager } from "../SqlJsManager";

const INDEX_DB_SCHEMA = `
PRAGMA user_version = 1;
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS book(
  key        TEXT PRIMARY KEY,
  id         INTEGER,
  title      TEXT NOT NULL,
  authors    TEXT,
  vault_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_book_path ON book(vault_path);
`;

export class LocalIndexService implements Disposable, SettingsObserver {
	private settings: KoreaderHighlightImporterSettings;
	private readonly SCOPE = "LocalIndexService";
	private idxDb: Database | null = null;
	private idxInitializing: Promise<void> | null = null;
	private isPersisting: Promise<void> | null = null;
	private isDirty = false;

	private idxPath: string;
	private pathCache: LruCache<string, string[]>;
	private persistIndexDebounced: DebouncedFn;

	constructor(
		private plugin: KoreaderImporterPlugin,
		private app: App,
		private fsService: FileSystemService,
		private cacheManager: CacheManager,
		private sqlJsManager: SqlJsManager,
		private readonly loggingService: LoggingService,
	) {
		this.settings = plugin.settings;
		this.idxPath = normalizePath(
			path.join(
				this.plugin.app.vault.configDir,
				"plugins",
				this.plugin.manifest.id,
				"highlight_index.sqlite",
			),
		);
		this.pathCache = this.cacheManager.createLru("db.path", 500);
		this.persistIndexDebounced = debounce(
			() => this.persistIndex(),
			5000,
			false,
		) as DebouncedFn;
	}

	/* ------------------------------------------------------------------ */
	/*                       ─── PUBLIC  API ───                          */
	/* ------------------------------------------------------------------ */

	public async initialize(): Promise<void> {
		await this.ensureIndexReady();
		this.registerVaultEvents();
		this.loggingService.info(
			this.SCOPE,
			"Service initialized and vault event listeners registered.",
		);
	}

	/**
	 * Generates a deterministic key from document properties.
	 * Used for consistent book identification across imports.
	 * @param props - Document properties containing title and authors
	 * @returns Normalized key in format "author::title"
	 */
	public bookKeyFromDocProps(props: DocProps): string {
		const authorSlug = normalizeFileNamePiece(props.authors).toLowerCase();
		const titleSlug = normalizeFileNamePiece(props.title).toLowerCase();
		return `${authorSlug}::${titleSlug}`;
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
		await this.ensureIndexReady();
		this.idxDb!.run(
			`INSERT INTO book(key,id,title,authors,vault_path) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET id=COALESCE(excluded.id, book.id), title=excluded.title, authors=excluded.authors, vault_path=COALESCE(excluded.vault_path, book.vault_path);`,
			[key, id, title, authors, vaultPath ?? null],
		);
		this.pathCache.delete(key);
		this.isDirty = true;
		this.persistIndexDebounced();
	}

	public onSettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
	): void {
		this.settings = newSettings;
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

	private async openIndexDatabase(): Promise<void> {
		const SQL = await this.sqlJsManager.getSqlJs();
		let dbContent: Uint8Array | null = null;
		let needsRebuild = false;

		try {
			// Ask for the file. The service will now throw a standard error if it fails.
			dbContent = await this.fsService.readNodeFile(this.idxPath, true);
		} catch (error: any) {
			if (error.code === "ENOENT") {
				this.loggingService.info(
					this.SCOPE,
					"No index DB found, creating a fresh one.",
				);
				needsRebuild = true;
			} else {
				// Any other error during read is critical and should stop the process.
				this.loggingService.error(
					this.SCOPE,
					`Could not read index DB file at ${this.idxPath}`,
					error,
				);
				new Notice(
					"KOReader Importer: Critical error reading plugin database. Check console.",
				);
				// Do not continue if we can't read the file for reasons other than it being missing.
				return;
			}
		}

		if (dbContent) {
			try {
				this.idxDb = new SQL.Database(dbContent);
				this.idxDb.exec("PRAGMA quick_check;");
			} catch (e: any) {
				if (e.message?.includes("malformed")) {
					this.loggingService.warn(
						this.SCOPE,
						`Index DB is corrupted. Deleting and rebuilding.`,
						e,
					);
					new Notice(
						"KOReader Importer: Database was corrupted. Rebuilding index.",
					);
					needsRebuild = true;
				} else {
					this.loggingService.error(
						this.SCOPE,
						`SQL error opening index DB.`,
						e,
					);
					new Notice(
						"KOReader Importer: Could not open plugin database. Check console.",
					);
					return;
				}
			}
		}

		if (needsRebuild) {
			try {
				if (await this.fsService.vaultExists(this.idxPath)) {
					await this.app.vault.adapter.remove(this.idxPath);
				}
			} catch (deleteError) {
				this.loggingService.error(
					this.SCOPE,
					`Failed to delete corrupted DB file.`,
					deleteError,
				);
			}
			this.idxDb = new SQL.Database();
			this.idxDb.run(INDEX_DB_SCHEMA);
			this.isDirty = true;
			await this.persistIndex(); // Persist immediately after creation
		}
	}

	public async flushIndex(): Promise<void> {
		this.persistIndexDebounced.cancel();
		await this.persistIndex();
	}

	private async persistIndex() {
		if (!this.idxDb || !this.isDirty || this.isPersisting) return;

		this.isPersisting = (async () => {
			this.loggingService.info(
				this.SCOPE,
				"Persisting index database to disk...",
			);
			try {
				const data = this.idxDb!.export();
				await this.fsService.writeNodeFile(this.idxPath, data);
				this.isDirty = false;
				this.loggingService.info(
					this.SCOPE,
					"Index database persisted successfully.",
				);
			} catch (error) {
				this.loggingService.error(
					this.SCOPE,
					"Failed to persist index database.",
					error,
				);
			} finally {
				this.isPersisting = null;
			}
		})();
		await this.isPersisting;
	}

	public async dispose(): Promise<void> {
		await this.flushIndex();
		this.idxDb?.close();
	}

	private registerVaultEvents(): void {
		this.plugin.registerEvent(
			this.app.vault.on("rename", this.handleRename.bind(this)),
		);
		this.plugin.registerEvent(
			this.app.vault.on("delete", this.handleDelete.bind(this)),
		);
	}

	private async handleRename(
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> {
		await this.ensureIndexReady();
		if (!this.idxDb) return;
		this.cacheManager.clear("db.path");

		if (file instanceof TFolder) {
			this.idxDb.run(
				`UPDATE book SET vault_path = REPLACE(vault_path, ?, ?) WHERE vault_path LIKE ?`,
				[`${oldPath}/`, `${file.path}/`, `${oldPath}/%`],
			);
		} else if (file instanceof TFile) {
			this.idxDb.run(`UPDATE book SET vault_path = ? WHERE vault_path = ?`, [
				file.path,
				oldPath,
			]);
		}

		const changed = this.idxDb.getRowsModified();

		if (changed > 0) {
			this.isDirty = true;
			this.persistIndexDebounced();
		}
	}

	private async handleDelete(file: TAbstractFile): Promise<void> {
		await this.ensureIndexReady();
		if (!this.idxDb) return;
		this.cacheManager.clear("db.path");
		const pathToDelete = file.path;

		if (file instanceof TFolder) {
			this.idxDb.run(
				`UPDATE book SET vault_path = NULL WHERE vault_path LIKE ?`,
				[`${pathToDelete}/%`],
			);
		} else if (file instanceof TFile) {
			this.idxDb.run(`UPDATE book SET vault_path = NULL WHERE vault_path = ?`, [
				pathToDelete,
			]);
		}

		const changed = this.idxDb.getRowsModified();

		if (changed > 0) {
			this.isDirty = true;
			this.persistIndexDebounced();
		}
	}
}
