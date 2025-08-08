import { homedir, platform } from "node:os";
import path from "node:path";
import {
	type App,
	type CachedMetadata,
	debounce,
	Notice,
	type TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import type { Database } from "sql.js";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type {
	DebouncedFn,
	Disposable,
	DocProps,
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import { ConcurrentDatabase } from "src/utils/ConcurrentDatabase";
import type { CacheManager } from "src/utils/cache/CacheManager";
import type { LruCache } from "src/utils/cache/LruCache";
import { normalizeFileNamePiece } from "src/utils/formatUtils";
import { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { SqlJsManager } from "../SqlJsManager";
import { ParallelIndexProcessor } from "./ParallelIndexProcessor";

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

interface DebouncedMetadataChangeHandler extends DebouncedFn {
	(file: TFile, data: string, cache: CachedMetadata): void;
}

export class LocalIndexService implements Disposable, SettingsObserver {
	private settings: KoreaderHighlightImporterSettings;
	private readonly SCOPE = "LocalIndexService";
	private idxDb: Database | null = null;
	private idxInitializing: Promise<void> | null = null;
	private concurrentDb: ConcurrentDatabase | null = null;

	private idxPath: string;
	private pathCache: LruCache<string, string[]>;
	private persistIndexDebounced: DebouncedFn;
	private debouncedHandleMetadataChange: (
		file: TFile,
		data: string,
		cache: CachedMetadata,
	) => void;

	// Degraded-mode capability
	private indexState: "persistent" | "in_memory" | "unavailable" =
		"unavailable";

	// Async rebuild state when running in-memory
	private rebuildAbortController: AbortController | null = null;
	private rebuildNotice: Notice | null = null;
	private rebuildProgress: { current: number; total: number } | null = null;
	private processedDuringRebuild: Set<string> | null = null;
	private isRebuildingFlag = false;

	public getIndexState(): "persistent" | "in_memory" | "unavailable" {
		return this.indexState;
	}
	/** Whether a background rebuild is currently in progress */
	public get isRebuilding(): boolean {
		return this.isRebuildingFlag;
	}
	/** Allows UI to cancel a long background rebuild */
	public cancelRebuild(): void {
		this.rebuildAbortController?.abort();
	}

	/**
	 * Proactive check for degraded mode. Shows a one-time Notice if index is not persistent.
	 * Call this early in flows that depend on duplicate detection to inform the user.
	 */
	public warnIfDegradedMode(): void {
		if (this.indexState !== "persistent") {
			// Use a lightweight session flag on the plugin instance to avoid repeated notices
			const anyPlugin = this.plugin as any;
			if (!anyPlugin.__kohlWarnedDegraded) {
				new Notice(
					"KOReader Importer: running without a persistent index. Duplicate detection will be slower and may time out.",
					8000,
				);
				this.loggingService.warn(
					this.SCOPE,
					`Index state is "${this.indexState}". Operating in degraded scan mode.`,
				);
				anyPlugin.__kohlWarnedDegraded = true;
			}
		}
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
		private readonly frontmatterService: FrontmatterService,
	) {
		this.settings = plugin.settings;

		// Use a vault-relative, normalized path for cross-platform adapter compatibility
		this.idxPath = this.fsService.joinPluginDataPath("highlight_index.sqlite");

		this.pathCache = this.cacheManager.createLru("db.path", 500);
		this.persistIndexDebounced = debounce(
			() => {
				if (this.isIndexPersistent() && this.idxDb) {
					this.sqlJsManager.persistDatabase(this.idxPath);
				}
			},
			5000,
			false,
		) as DebouncedFn;

		// Debounced metadata change handler to avoid thrashing during edits
		const debounced = debounce(
			(file: TFile, data: string, cache: CachedMetadata) => {
				void this._handleMetadataChange(file, data, cache);
			},
			1500,
			false,
		);
		this.debouncedHandleMetadataChange = (
			file: TFile,
			data: string,
			cache: CachedMetadata,
		) => {
			(
				debounced as unknown as (
					file: TFile,
					data: string,
					cache: CachedMetadata,
				) => void
			)(file, data, cache);
		};

		// Initialize index processor once DB is available (lazy via getter later if needed)
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
		// Proactively inform user if we're not persistent
		this.warnIfDegradedMode();

		// If we're in-memory, proactively start a non-blocking background rebuild
		// so future duplicate checks can be O(1) against the temporary index.
		if (this.indexState === "in_memory" && !this.isRebuilding) {
			this.startBackgroundRebuild().catch((e) => {
				this.loggingService.error(this.SCOPE, "Failed to start rebuild", e);
			});
		}
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

		const db = await this.getConcurrentDb();
		return db.execute((database) => {
			const stmt = database.prepare(
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
		await db.execute((database) => {
			database.run(
				`INSERT INTO book(key,id,title,authors,vault_path) VALUES(?,?,?,?,?)
		               ON CONFLICT(key) DO UPDATE SET
		                  id=COALESCE(excluded.id, book.id),
		                  title=excluded.title,
		                  authors=excluded.authors,
		                  vault_path=excluded.vault_path;`,
				[key, id, title, authors, vaultPath ?? null],
			);
		}, true);
		this.pathCache.delete(key);
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
				// Ensure the brand-new DB is flushed at least once to disk
				await this.sqlJsManager.persistDatabase(this.idxPath);
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
			this.concurrentDb = new ConcurrentDatabase(
				async () => {
					if (!this.idxDb) throw new Error("Index DB not initialized");
					return this.idxDb;
				},
				undefined, // in-memory persistence handled separately
			);
		} catch (memErr) {
			this.loggingService.error(
				this.SCOPE,
				"Failed to initialize in-memory index database.",
				memErr,
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
				this.loggingService.warn(
					this.SCOPE,
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
				this.loggingService.warn(
					this.SCOPE,
					"Index rebuild cancelled by user.",
				);
				return;
			}

			if (result.errors.length > 0) {
				this.loggingService.warn(
					this.SCOPE,
					`Index rebuild completed with ${result.errors.length} errors.`,
				);
			}

			this.finishRebuildNotice(false, "✅ Temporary index ready");
			this.loggingService.info(
				this.SCOPE,
				"In-memory index rebuild completed.",
			);
		} catch (e: any) {
			if (e?.name === "AbortError") {
				this.finishRebuildNotice(false, "⏸ Index rebuild cancelled");
				this.loggingService.warn(
					this.SCOPE,
					"Index rebuild cancelled by user.",
				);
			} else {
				this.finishRebuildNotice(
					true,
					"⚠️ Rebuild failed. Using slower duplicate detection",
				);
				this.loggingService.error(this.SCOPE, "Index rebuild failed", e);
			}
		} finally {
			this.rebuildAbortController = null;
			this.rebuildProgress = null;
			this.isRebuildingFlag = false;
		}
	}

	private throwIfAborted(): void {
		if (this.rebuildAbortController?.signal.aborted) {
			// Use DOMException semantics for consistency
			const err = new DOMException("Aborted", "AbortError");
			throw err;
		}
	}

	// Deprecated: replaced by ParallelIndexProcessor
	private async processFileIntoIndex(_file: TFile): Promise<void> {
		// no-op
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
				this.loggingService.error(
					this.SCOPE,
					`Failed to save index to ${this.idxPath}`,
					e as Error,
				);
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
		this.loggingService.warn(
			this.SCOPE,
			"Deleting persistent index database file.",
		);

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
				this.loggingService.info(
					this.SCOPE,
					"Successfully deleted index file.",
				);
			}
		} catch (error) {
			this.loggingService.error(
				this.SCOPE,
				`Failed to delete index file at ${this.idxPath}`,
				error as Error,
			);
			// Proceed anyway; in-memory state is cleared.
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
		await db.execute((database) => {
			database.run("BEGIN IMMEDIATE;");
			try {
				if (file instanceof TFolder) {
					database.run(
						`UPDATE book SET vault_path = REPLACE(vault_path, ?, ?) WHERE vault_path LIKE ?`,
						[`${oldPath}/`, `${(file as TFolder).path}/`, `${oldPath}/%`],
					);
				} else if (file instanceof TFile) {
					database.run(`UPDATE book SET vault_path = ? WHERE vault_path = ?`, [
						(file as TFile).path,
						oldPath,
					]);
				}

				if (database.getRowsModified() > 0) {
					database.run("COMMIT;");
					this.persistIndexDebounced();
				} else {
					database.run("ROLLBACK;");
				}
			} catch (e) {
				database.run("ROLLBACK;");
				this.loggingService.error(
					this.SCOPE,
					`Transaction failed for handleRename: ${oldPath} -> ${(file as any)?.path}`,
					e,
				);
				throw e;
			}
		}, true);
	}

	private async handleDelete(file: TAbstractFile): Promise<void> {
		this.cacheManager.clear("db.path");
		const pathToDelete = file.path;

		const db = await this.getConcurrentDb();
		await db.execute((database) => {
			database.run("BEGIN IMMEDIATE;");
			try {
				if (file instanceof TFolder) {
					database.run(
						`UPDATE book SET vault_path = NULL WHERE vault_path LIKE ?`,
						[`${pathToDelete}/%`],
					);
				} else if (file instanceof TFile) {
					database.run(
						`UPDATE book SET vault_path = NULL WHERE vault_path = ?`,
						[pathToDelete],
					);
				}

				if (database.getRowsModified() > 0) {
					database.run("COMMIT;");
					this.persistIndexDebounced();
				} else {
					database.run("ROLLBACK;");
				}
			} catch (e) {
				database.run("ROLLBACK;");
				this.loggingService.error(
					this.SCOPE,
					`Transaction failed for handleDelete: ${pathToDelete}`,
					e,
				);
				throw e;
			}
		}, true);
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

			const oldKey = await this.findKeyByVaultPath(file.path);
			const metadata = await this.frontmatterService.extractMetadata(file);

			if (!metadata) {
				if (oldKey) {
					this.loggingService.info(
						this.SCOPE,
						`Note ${file.path} lost identifying frontmatter. Removing from index.`,
					);
					await this.removePathFromIndex(file.path, oldKey);
				}
				return;
			}

			if (oldKey && oldKey !== metadata.key) {
				this.loggingService.info(
					this.SCOPE,
					`Book key for ${file.path} changed from "${oldKey}" to "${metadata.key}". Updating index.`,
				);
				await this.removePathFromIndex(file.path, oldKey);
			}

			await this.upsertBook(
				null,
				metadata.key,
				metadata.title,
				metadata.authors,
				file.path,
			);
		} catch (e) {
			this.loggingService.warn(
				this.SCOPE,
				"Failed handling metadata change",
				e,
			);
		}
	}

	private async findKeyByVaultPath(vaultPath: string): Promise<string | null> {
		const db = await this.getConcurrentDb();
		return db.execute((database) => {
			const stmt = database.prepare(
				"SELECT key FROM book WHERE vault_path = ?",
			);
			try {
				stmt.bind([vaultPath]);
				return stmt.step() ? (stmt.getAsObject().key as string) : null;
			} finally {
				stmt.free();
			}
		});
	}

	private async removePathFromIndex(
		vaultPath: string,
		oldKey: string,
	): Promise<void> {
		const db = await this.getConcurrentDb();
		await db.execute((database) => {
			database.run("BEGIN IMMEDIATE;");
			try {
				database.run(`UPDATE book SET vault_path = NULL WHERE vault_path = ?`, [
					vaultPath,
				]);
				const modified = database.getRowsModified();
				if (modified > 0) {
					database.run("COMMIT;");
					// Only update caches/persistence after a successful commit
					this.pathCache.delete(oldKey);
					this.persistIndexDebounced();
				} else {
					database.run("ROLLBACK;");
				}
			} catch (e) {
				database.run("ROLLBACK;");
				this.loggingService.error(
					this.SCOPE,
					`Transaction failed for removePathFromIndex: ${vaultPath}`,
					e,
				);
				throw e;
			}
		}, true);
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
