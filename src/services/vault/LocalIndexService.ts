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
	 * folder and inserting book rows. This is non-blocking and chunked with progress.
	 */
	private async startBackgroundRebuild(): Promise<void> {
		if (this.isRebuilding) return;
		this.isRebuildingFlag = true;
		this.rebuildAbortController = new AbortController();
		this.processedDuringRebuild = new Set();
		this.rebuildProgress = { current: 0, total: 0 };

		// Long-lived notice with progress updates
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
			const files: TFile[] = Array.from(this.walkMarkdownFiles(root));
			this.rebuildProgress.total = files.length;
			this.updateRebuildNotice();

			// Use a small pool to avoid blocking UI; reuse our Mutex-based db serializer
			const POOL = 4;
			const BATCH = 24; // process in small visible increments
			for (let i = 0; i < files.length; i += BATCH) {
				this.throwIfAborted();
				const slice = files.slice(i, i + BATCH);

				// Map over a pool of 4 workers
				await Promise.all(
					Array.from({ length: Math.min(POOL, slice.length) }, async (_, w) => {
						for (let j = w; j < slice.length; j += POOL) {
							this.throwIfAborted();
							const file = slice[j];
							await this.processFileIntoIndex(file);
							this.rebuildProgress!.current++;
							// Throttle updates a bit by only updating every few files
							if (this.rebuildProgress!.current % 5 === 0) {
								this.updateRebuildNotice();
							}
						}
					}),
				);

				// Ensure a visible update between batches
				this.updateRebuildNotice();
				// Yield to event loop to keep UI responsive
				await new Promise((r) => setTimeout(r, 0));
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
			this.processedDuringRebuild = null;
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

	private async processFileIntoIndex(file: TFile): Promise<void> {
		if (!this.concurrentDb || !this.idxDb) return; // nothing to do if DB unavailable
		if (this.processedDuringRebuild?.has(file.path)) return;

		try {
			// Parse only frontmatter quickly using cached metadata path in FrontmatterService
			// We don't have direct access here; instead, parse minimally by reading first KB if needed.
			// For simplicity and reliability, read full file and extract naive title/authors from YAML frontmatter.
			const content = await this.app.vault.read(file);
			const fmMatch = content.match(
				/^---\s*?\r?\n([\s\S]+?)\r?\n---\s*?\r?\n?/s,
			);
			let title = "";
			let authors = "";
			if (fmMatch) {
				try {
					// Lazy import to avoid circular deps; parse as YAML via Obsidian's parseYaml on demand
					const { parseYaml } = await import("obsidian");
					const fm = (parseYaml(fmMatch[1]) ?? {}) as Record<string, unknown>;
					// Accept either friendly keys or normalized keys
					title = String(fm.Title ?? fm.title ?? "");
					authors = String(fm["Author(s)"] ?? fm.authors ?? "");
				} catch {
					// ignore file-level parse errors
				}
			}
			if (!title && !authors) {
				// Skip files with no identifying metadata
				return;
			}
			const key = this.bookKeyFromDocProps({ title, authors });

			await this.concurrentDb.execute((db) => {
				db.run(
					`INSERT INTO book(key,id,title,authors,vault_path) VALUES(?,?,?,?,?)
			                  ON CONFLICT(key) DO UPDATE SET
			                     id=COALESCE(excluded.id, book.id),
			                     title=excluded.title,
			                     authors=excluded.authors,
			                     vault_path=excluded.vault_path;`,
					[key, null, title, authors, file.path],
				);
			}, true);

			this.processedDuringRebuild?.add(file.path);
			// In-memory: no persistence to disk needed
		} catch (e) {
			this.loggingService.warn(
				this.SCOPE,
				`Failed to process file for temporary index: ${file.path}`,
				e,
			);
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
				this.persistIndexDebounced();
			}
		}, true);
	}

	private async handleDelete(file: TAbstractFile): Promise<void> {
		this.cacheManager.clear("db.path");
		const pathToDelete = file.path;

		const db = await this.getConcurrentDb();
		await db.execute((database) => {
			if (file instanceof TFolder) {
				database.run(
					`UPDATE book SET vault_path = NULL WHERE vault_path LIKE ?`,
					[`${pathToDelete}/%`],
				);
			} else if (file instanceof TFile) {
				database.run(`UPDATE book SET vault_path = NULL WHERE vault_path = ?`, [
					pathToDelete,
				]);
			}

			if (database.getRowsModified() > 0) {
				this.persistIndexDebounced();
			}
		}, true);
	}
	private async _handleMetadataChange(
		file: TFile,
		data: string,
		cache: CachedMetadata,
	): Promise<void> {
		try {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			if (!this.settings.highlightsFolder) return;
			if (!file.path.startsWith(this.settings.highlightsFolder)) return;

			const newTitle =
				(cache.frontmatter?.title as string | undefined) ?? undefined;
			let newAuthors = cache.frontmatter?.authors as
				| string
				| string[]
				| undefined;
			if (Array.isArray(newAuthors)) newAuthors = newAuthors.join(",");

			const oldKey = await this.findKeyByVaultPath(file.path);

			if (!newTitle || !newAuthors) {
				if (oldKey) {
					this.loggingService.info(
						this.SCOPE,
						`Note ${file.path} lost identifying frontmatter. Removing from index.`,
					);
					await this.removePathFromIndex(file.path, oldKey);
				}
				return;
			}

			const newKey = this.bookKeyFromDocProps({
				title: newTitle,
				authors: newAuthors,
			});

			if (oldKey && oldKey !== newKey) {
				this.loggingService.info(
					this.SCOPE,
					`Book key for ${file.path} changed from "${oldKey}" to "${newKey}". Updating index.`,
				);
				await this.removePathFromIndex(file.path, oldKey);
			}

			await this.upsertBook(null, newKey, newTitle, newAuthors, file.path);
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
			database.run(`UPDATE book SET vault_path = NULL WHERE vault_path = ?`, [
				vaultPath,
			]);
		}, true);
		this.pathCache.delete(oldKey);
		this.persistIndexDebounced();
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

	// Minimal recursive walker to enumerate markdown files under a TFolder
	private *walkMarkdownFiles(entry: any): Generator<TFile> {
		if (entry instanceof TFile) {
			if (entry.extension === "md") yield entry;
			return;
		}
		const children = (entry as any)?.children as any[] | undefined;
		if (!children) return;
		for (const child of children) {
			if (child instanceof TFile) {
				if (child.extension === "md") yield child;
			} else {
				yield* this.walkMarkdownFiles(child);
			}
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
