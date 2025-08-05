import { homedir, platform } from "node:os";
import path from "node:path";
import {
	type App,
	debounce,
	Notice,
	type TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import type { Database } from "sql.js";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type {
	DebouncedFn,
	Disposable,
	DocProps,
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import type { CacheManager } from "src/utils/cache/CacheManager";
import type { LruCache } from "src/utils/cache/LruCache";
import { normalizeFileNamePiece } from "src/utils/formatUtils";
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

	private idxPath: string;
	private pathCache: LruCache<string, string[]>;
	private persistIndexDebounced: DebouncedFn;

	// Degraded-mode capability
	private indexState: "persistent" | "in_memory" | "unavailable" =
		"unavailable";

	public getIndexState(): "persistent" | "in_memory" | "unavailable" {
		return this.indexState;
	}

	public isIndexPersistent(): boolean {
		return this.indexState === "persistent";
	}

	constructor(
		private plugin: KoreaderImporterPlugin,
		private app: App,
		private fsService: FileSystemService,
		private cacheManager: CacheManager,
		private sqlJsManager: SqlJsManager,
		private readonly loggingService: LoggingService,
	) {
		this.settings = plugin.settings;

		this.idxPath = path.join(
			this.app.vault.configDir,
			"plugins",
			this.plugin.manifest.id, // Use manifest ID for correctness
			"highlight_index.sqlite",
		);

		this.pathCache = this.cacheManager.createLru("db.path", 500);
		this.persistIndexDebounced = debounce(
			() => {
				// The check for persistence is now simpler: idxPath is always set.
				if (this.isIndexPersistent() && this.idxDb) {
					this.sqlJsManager.persistDatabase(this.idxPath);
				}
			},
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
			`Service initialized. Index path: ${this.idxPath}`,
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
		const stmt = this.idxDb!.prepare(
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
		this.sqlJsManager.setDirty(this.idxPath, true);
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
			// If idxPath is invalid (e.g., could not be determined), skip directly to in-memory mode.
			if (!this.idxPath) {
				// The check is now just for a valid path string.
				this.loggingService.info(
					this.SCOPE,
					"Persistent index path not available. Initializing in-memory DB.",
				);
				await this.initializeInMemoryDb();
				this.idxInitializing = null;
				return;
			}

			try {
				// No need to ensure vault folder, as writeNodeFile will do it.
				this.idxDb = await this.sqlJsManager.openDatabase(this.idxPath, {
					schemaSql: INDEX_DB_SCHEMA,
					validate: true,
				});
				this.indexState = "persistent";
			} catch (error) {
				this.loggingService.warn(
					this.SCOPE,
					"Persistent index unavailable; falling back to in-memory...",
					error,
				);
				new Notice(
					"KOReader Importer: Index is in-memory. Duplicate detection will be slower this session.",
					8000,
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
			this.sqlJsManager.applySchema(this.idxDb, INDEX_DB_SCHEMA);
			this.indexState = "in_memory";
		} catch (memErr) {
			this.loggingService.error(
				this.SCOPE,
				"Failed to initialize in-memory index database.",
				memErr,
			);
			this.idxDb = null;
			this.indexState = "unavailable";
		}
	}

	public async flushIndex(): Promise<void> {
		this.persistIndexDebounced.cancel();
		if (this.isIndexPersistent() && this.idxDb) {
			await this.sqlJsManager.persistDatabase(this.idxPath);
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

		if (this.idxDb.getRowsModified() > 0) {
			this.sqlJsManager.setDirty(this.idxPath, true);
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

		if (this.idxDb.getRowsModified() > 0) {
			this.sqlJsManager.setDirty(this.idxPath, true);
			this.persistIndexDebounced();
		}
	}
}

function getGlobalObsidianAppDataPath(): string | null {
	const p = platform();
	let dataPath: string | undefined;

	if (p === "win32") {
		dataPath = process.env.APPDATA; // Roaming AppData
	} else if (p === "darwin") {
		dataPath = path.join(homedir(), "Library/Application Support");
	} else {
		// linux
		dataPath = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
	}

	if (!dataPath) return null;
	return path.join(dataPath, "obsidian");
}
