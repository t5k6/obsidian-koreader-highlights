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
import type { CacheManager, IterableCache } from "src/lib/cache";
import { isErr } from "src/lib/core/result";
import { Pathing } from "src/lib/pathing";
import type KoreaderImporterPlugin from "src/main";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
import type {
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import type { IndexDatabase } from "./IndexDatabase";
import { SQL_BOOK, SQL_SOURCE } from "./schema";

namespace Books {
	export function upsertBook(
		db: Database,
		key: string,
		id: number | null,
		title: string,
		authors: string,
	): void {
		db.run(SQL_BOOK.UPSERT_BOOK, [key, id, title, authors]);
	}

	export function ensureBookExists(db: Database, key: string): void {
		db.run(SQL_BOOK.INSERT_BOOK_IF_NOT_EXISTS, [key]);
	}

	export function upsertInstance(
		db: Database,
		bookKey: string,
		vaultPath: string,
	): void {
		db.run(SQL_BOOK.UPSERT_INSTANCE, [bookKey, vaultPath]);
	}

	export function deleteInstanceByPath(db: Database, vaultPath: string): void {
		db.run(SQL_BOOK.DELETE_INSTANCE_BY_PATH, [vaultPath]);
	}

	export function findKeyByVaultPath(
		db: Database,
		vaultPath: string,
	): string | null {
		const stmt = db.prepare(SQL_BOOK.SELECT_BOOK_KEY_BY_PATH);
		try {
			stmt.bind([vaultPath]);
			return stmt.step()
				? ((stmt.getAsObject().book_key as string) ?? null)
				: null;
		} finally {
			stmt.free();
		}
	}

	export function findPathsByBookKey(db: Database, bookKey: string): string[] {
		const out: string[] = [];
		const stmt = db.prepare(SQL_BOOK.SELECT_PATHS_BY_BOOK_KEY);
		try {
			stmt.bind([bookKey]);
			while (stmt.step()) {
				const row = stmt.getAsObject();
				const p = row.vault_path as string | undefined;
				if (p) out.push(p);
			}
			return out;
		} finally {
			stmt.free();
		}
	}

	export function handleRenameFolder(
		db: Database,
		oldPath: string,
		newPath: string,
	): void {
		db.run(SQL_BOOK.RENAME_FOLDER, [
			`${oldPath}/`,
			`${newPath}/`,
			`${oldPath}/%`,
		]);
	}

	export function handleRenameFile(
		db: Database,
		oldPath: string,
		newPath: string,
	): void {
		db.run(SQL_BOOK.RENAME_FILE, [newPath, oldPath]);
	}
}

namespace Sources {
	export type ImportSourceRow = {
		source_path: string;
		last_processed_mtime: number;
		last_processed_size: number;
		newest_annotation_ts: string | null;
		last_success_ts: number | null;
		last_error: string | null;
		book_key: string | null;
		md5: string | null;
	};

	export function getByPath(
		db: Database,
		path: string,
	): ImportSourceRow | null {
		const stmt = db.prepare(SQL_SOURCE.GET_BY_PATH);
		try {
			stmt.bind([path]);
			if (!stmt.step()) return null;
			const r = stmt.getAsObject();
			return {
				source_path: r.source_path as string,
				last_processed_mtime: (r.last_processed_mtime as number) ?? 0,
				last_processed_size: (r.last_processed_size as number) ?? 0,
				newest_annotation_ts: (r.newest_annotation_ts as string) ?? null,
				last_success_ts: (r.last_success_ts as number) ?? null,
				last_error: (r.last_error as string) ?? null,
				book_key: (r.book_key as string) ?? null,
				md5: (r.md5 as string) ?? null,
			};
		} finally {
			stmt.free();
		}
	}

	export function upsertSuccess(
		db: Database,
		p: {
			path: string;
			mtime: number;
			size: number;
			newestAnnotationTs: string | null;
			bookKey?: string | null;
			md5?: string | null;
		},
	): void {
		db.run(SQL_SOURCE.UPSERT_SUCCESS, [
			p.path,
			p.mtime,
			p.size,
			p.newestAnnotationTs ?? null,
			Date.now(),
			null,
			p.bookKey ?? null,
			p.md5 ?? null,
		]);
	}

	export function upsertFailure(
		db: Database,
		path: string,
		error: unknown,
	): void {
		const msg =
			typeof error === "string"
				? error
				: ((error as any)?.message ?? JSON.stringify(error ?? "error"));
		db.run(SQL_SOURCE.UPSERT_FAILURE, [path, 0, 0, msg]);
	}

	export function deleteByPath(db: Database, path: string): void {
		db.run(SQL_SOURCE.DELETE_BY_PATH, [path]);
	}

	export function clearAll(db: Database): void {
		db.run(SQL_SOURCE.CLEAR_ALL);
	}

	export function latestSourceForBook(
		db: Database,
		bookKey: string,
	): string | null {
		const stmt = db.prepare(SQL_SOURCE.LATEST_SOURCE_FOR_BOOK);
		try {
			stmt.bind([bookKey]);
			if (!stmt.step()) return null;
			const row = stmt.getAsObject();
			return (row.source_path as string) ?? null;
		} finally {
			stmt.free();
		}
	}

	export function shouldProcess(
		existing: ImportSourceRow | null,
		stats: { mtime: number; size: number },
		newestAnnotationTs: string | null,
	): boolean {
		// 1. New file, always process.
		if (!existing) {
			return true;
		}

		// 2. File was modified on disk, must re-process.
		if (
			existing.last_processed_mtime !== stats.mtime ||
			existing.last_processed_size !== stats.size
		) {
			return true;
		}

		// 3. Last attempt failed, must re-process.
		if (existing.last_error !== null || existing.last_success_ts === null) {
			return true;
		}

		// 4. File is unchanged, but new annotations have appeared.
		const hasNewerAnnotation = !!(
			newestAnnotationTs &&
			newestAnnotationTs > (existing.newest_annotation_ts ?? "")
		);
		if (hasNewerAnnotation) {
			return true;
		}

		// 5. File is identical to last successful import, no need to process.
		return false;
	}
}

export class IndexCoordinator implements SettingsObserver {
	private readonly log: {
		info: (...args: unknown[]) => void;
		warn: (...args: unknown[]) => void;
		error: (...args: unknown[]) => void;
	};
	private readonly logging: LoggingService;
	private settings!: KoreaderHighlightImporterSettings;
	private pathCache!: IterableCache<string, string[]>;
	private readonly cacheManager: CacheManager;
	private persistIndexDebounced!: Debouncer<[], void>;
	public debouncedHandleMetadataChange!: Debouncer<
		[TFile, string, CachedMetadata],
		void
	>;

	private rebuildNotice: Notice | null = null;
	private unsubscribeRebuild?: () => void;

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly indexDb: IndexDatabase,
		private readonly fm: FrontmatterService,
		private readonly fsService: FileSystemService,
		logging: LoggingService,
		cacheManager: CacheManager,
	) {
		this.logging = logging;
		this.log = logging.scoped("IndexCoordinator");
		this.settings = this.plugin.settings;
		this.cacheManager = cacheManager;
		this.pathCache = this.cacheManager.createLru("db.path", 2000);

		// Set up debounced helpers
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

	private createRebuildWriter(): (
		batch: import("src/types").BookMetadata[],
	) => Promise<void> {
		return async (batch: import("src/types").BookMetadata[]): Promise<void> => {
			const db = this.indexDb.getConcurrent();
			await db.writeTx((d) => {
				for (const { key, title, authors, vaultPath } of batch) {
					Books.upsertBook(d, key, null, title, authors);
					if (vaultPath) {
						Books.upsertInstance(d, key, vaultPath);
					}
				}
			});
		};
	}

	public async initialize(): Promise<void> {
		await this.indexDb.whenReady();
		this.registerVaultEvents();

		if (this.indexDb.getState() === "in_memory") {
			this.subscribeRebuildUi();

			// Use the new reusable writer method
			const writer = this.createRebuildWriter();

			void this.indexDb.startBackgroundRebuild({
				app: this.app,
				fm: this.fm,
				highlightsFolder: this.settings.highlightsFolder ?? "",
				writer: writer,
			});
		}
	}

	private subscribeRebuildUi(): void {
		// cleanup previous
		this.unsubscribeRebuild?.();

		this.unsubscribeRebuild = this.indexDb.onRebuildStatus((s) => {
			switch (s.phase) {
				case "rebuilding": {
					if (!this.rebuildNotice) {
						this.rebuildNotice = new Notice("📚 Building temporary index…", 0);
					}
					const { current = 0, total = 0 } = s.progress ?? {
						current: 0,
						total: 0,
					};
					const pct = total === 0 ? 100 : Math.round((current / total) * 100);
					this.rebuildNotice.setMessage(
						`📚 Building index: ${current}/${total} files (${pct}%)`,
					);
					break;
				}
				case "complete": {
					this.safeHideNotice();
					new Notice("✅ Temporary index ready", 3000);
					break;
				}
				case "failed": {
					this.safeHideNotice();
					new Notice(
						"⚠️ Rebuild failed. Using slower duplicate detection",
						5000,
					);
					break;
				}
				case "cancelled": {
					this.safeHideNotice();
					new Notice("⏸ Index rebuild cancelled", 3000);
					break;
				}
				case "idle":
				default:
					// no-op
					break;
			}
		});
	}

	private safeHideNotice(): void {
		try {
			this.rebuildNotice?.hide();
		} catch {
			// ignore
		}
		this.rebuildNotice = null;
	}

	public register(plugin: { registerEvent: (e: any) => void }): void {
		this.registerVaultEvents();
	}

	public onSettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
		oldSettings?: KoreaderHighlightImporterSettings,
	): void {
		this.settings = newSettings;
		if (
			!oldSettings ||
			oldSettings.highlightsFolder !== newSettings.highlightsFolder
		) {
			this.invalidateIndexCaches();
			if (this.indexDb.getState() === "in_memory") {
				this.indexDb.cancelRebuild();
				// restart with new folder
				const writer = this.createRebuildWriter();

				void this.indexDb.startBackgroundRebuild({
					app: this.app,
					fm: this.fm,
					highlightsFolder: this.settings.highlightsFolder ?? "",
					writer: writer,
				});
			}
		}
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

	public async handleRename(
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> {
		this.invalidateIndexCaches();

		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		await db.writeTx((d) => {
			if (file instanceof TFolder) {
				Books.handleRenameFolder(d, oldPath, (file as TFolder).path);
			} else if (file instanceof TFile) {
				Books.handleRenameFile(d, oldPath, (file as TFile).path);
			}
			return undefined;
		});
		this.persistIndexDebounced();
	}

	public async handleDelete(file: TAbstractFile): Promise<void> {
		this.invalidateIndexCaches();
		if (!this.indexDb.isReady()) return;
	
		const db = this.indexDb.getConcurrent();
		const changed = await db.writeTx((d) => {
			if (file instanceof TFile) {
				const pathToDelete = file.path;
	
				// Find the conceptual book key associated with the deleted file path.
				const bookKey = Books.findKeyByVaultPath(d, pathToDelete);
	
				// First, delete the instance from the index. This breaks the link
				// between the conceptual book and the now-deleted vault file.
				Books.deleteInstanceByPath(d, pathToDelete);
	
				// CRITICAL: If a book key was found, we must also reset the import status
				// for the source file that created this note. The `import_source` table
				// acts as a "receipt" of a successful import. By deleting the receipt,
				// we are telling the plugin: "The product of this import is gone.
				// Please re-process the source file from scratch on the next run."
				// Failure to do this would cause the import to be skipped, as the
				// plugin would still think the import was successfully completed.
				if (bookKey) {
					const sourcePath = Sources.latestSourceForBook(d, bookKey);
					if (sourcePath) {
						Sources.deleteByPath(d, sourcePath);
						this.log.info(
							`Reset import status for source '${sourcePath}' due to deletion of note '${pathToDelete}'`,
						);
					}
				}
			} else if (file instanceof TFolder) {
				// Folder deletions are simpler: just remove all instances within that path.
				// We do not try to reset import sources, as it's ambiguous.
				d.run(`DELETE FROM book_instances WHERE vault_path LIKE ?`, [`${file.path}/%`]);
			}
			return d.getRowsModified() > 0;
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
			const metadata = await this.fm.extractMetadata(file);

			await this.indexDb.whenReady();
			const db = this.indexDb.getConcurrent();
			const result = await db.writeTx((d) => {
				// Existing mapping for this path
				const oldKey = Books.findKeyByVaultPath(d, file.path);

				if (!metadata) {
					if (oldKey) {
						Books.deleteInstanceByPath(d, file.path);
						return { changed: true, oldKey, newKey: null as string | null };
					}
					return {
						changed: false,
						oldKey: null as string | null,
						newKey: null as string | null,
					};
				}

				// Upsert conceptual book
				Books.upsertBook(
					d,
					metadata.key,
					null,
					metadata.title,
					metadata.authors,
				);

				// Ensure instance maps to the (possibly new) key
				Books.upsertInstance(d, metadata.key, file.path);

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

	// ------------------------ Public index API (migrated from LocalIndexService) ------------------------

	/** Returns per-source processing state or null if not recorded. */
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
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		return db.execute((d) => Sources.getByPath(d, path));
	}

	/** Determines whether a metadata.lua source should be processed. */
	public async shouldProcessSource(
		path: string,
		stats: { mtime: number; size: number },
		newestAnnotationTs: string | null,
	): Promise<boolean> {
		const existing = await this.getImportSource(path);
		return Sources.shouldProcess(existing, stats, newestAnnotationTs);
	}

	/** Record a successful import and (optionally) upsert book instance path. */
	public async recordImportSuccess(params: {
		path: string;
		mtime: number;
		size: number;
		newestAnnotationTs: string | null;
		bookKey?: string | null;
		md5?: string | null;
		vaultPath?: string | null;
	}): Promise<void> {
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		await db.writeTx((d) => {
			Sources.upsertSuccess(d, params);
			if (params.vaultPath && params.bookKey) {
				Books.ensureBookExists(d, params.bookKey);
				Books.upsertInstance(d, params.bookKey, params.vaultPath);
			}
			return undefined;
		});
		this.persistIndexDebounced();
	}

	/** Record a failed import for a source path. */
	public async recordImportFailure(
		path: string,
		error: unknown,
	): Promise<void> {
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		await db.writeTx((d) => {
			Sources.upsertFailure(d, path, error);
			return undefined;
		});
		this.persistIndexDebounced();
	}

	/** Delete a single import_source row. */
	public async deleteImportSource(path: string): Promise<void> {
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		await db.writeTx((d) => {
			Sources.deleteByPath(d, path);
			return undefined;
		});
		this.persistIndexDebounced();
	}

	/** Clears all import_source state so next import reprocesses everything. */
	public async clearImportSource(): Promise<void> {
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		await db.writeTx((d) => {
			Sources.clearAll(d);
			return undefined;
		});
		this.persistIndexDebounced();
	}

	/** Cached lookup of vault paths by conceptual key (book). */
	public async findExistingBookFiles(bookKey: string): Promise<string[]> {
		const cached = this.pathCache.get(bookKey);
		if (cached) return cached;
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		return db.execute((d) => {
			const paths = Books.findPathsByBookKey(d, bookKey);
			this.pathCache.set(bookKey, paths);
			return paths;
		});
	}

	/** Upsert a conceptual book and optionally an instance mapping to a vault path. */
	public async upsertBook(
		id: number | null,
		key: string,
		title: string,
		authors: string,
		vaultPath?: string,
	): Promise<void> {
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		await db.writeTx((d) => {
			Books.upsertBook(d, key, id, title, authors);
			if (vaultPath) Books.upsertInstance(d, key, vaultPath);
			return undefined;
		});
		this.pathCache.delete(key);
		this.persistIndexDebounced();
	}

	/** Find conceptual key by vault path (if any). */
	public async findKeyByVaultPath(vaultPath: string): Promise<string | null> {
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		return db.execute((d) => Books.findKeyByVaultPath(d, vaultPath));
	}

	/** Delete a single book instance row and clear relevant path cache entries. */
	public async deleteBookInstanceByPath(vaultPath: string): Promise<void> {
		const key = await this.findKeyByVaultPath(vaultPath);
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		const changed = await db.writeTx((d) => {
			Books.deleteInstanceByPath(d, vaultPath);
			return d.getRowsModified() > 0;
		});
		if (changed && key) this.pathCache.delete(key);
		if (changed) this.persistIndexDebounced();
	}

	/** Latest source path for a conceptual key, normalized for device mount roots. */
	public async latestSourceForBook(bookKey: string): Promise<string | null> {
		await this.indexDb.whenReady();
		const db = this.indexDb.getConcurrent();
		const raw = await db.execute((d) =>
			Sources.latestSourceForBook(d, bookKey),
		);
		if (!raw) return null;
		return Pathing.stripRootFromDevicePath(raw);
	}

	/** Destructive: delete persistent DB file (used for full reset). */
	public async deleteIndexFile(): Promise<void> {
		this.log.warn("Deleting persistent index database file.");
		await this.indexDb.dispose();
		this.pathCache.clear();
		try {
			const dbPath = this.fsService.joinPluginDataPath("index.db");
			const exists = await this.fsService.vaultExists(dbPath);
			if (!isErr(exists) && exists.value) {
				const rm = await this.fsService.removeVaultPath(dbPath);
				if (isErr(rm)) throw rm.error as any;
				this.log.info("Successfully deleted index file.");
			}
		} catch (e) {
			this.log.error("Failed to delete index file", e as Error);
		}
	}

	/**
	 * Centralized cache invalidation for index-related caches.
	 * This should be the only place where index-related caches are cleared.
	 */
	public invalidateIndexCaches(): void {
		try {
			this.pathCache.clear();
			// Note: CacheManager bucket clearing is handled by the service that owns it
			this.log.info("Index caches invalidated");
		} catch (e) {
			this.log.warn("Error invalidating index caches", e);
		}
	}

	public async flushIndex(): Promise<void> {
		this.persistIndexDebounced.cancel();
		try {
			await this.indexDb.flush();
		} catch (e) {
			this.log.error("Failed to flush index", e as Error);
			new Notice(
				`Failed to save index: ${e instanceof Error ? e.message : e}`,
				8000,
			);
			throw e;
		}
	}

	/** Narrow, testable signal for degraded in-memory rebuild mode */
	public isRebuildingIndex(): boolean {
		return (
			this.indexDb.getState() === "in_memory" && this.indexDb.isRebuilding()
		);
	}

	public async whenRebuildComplete(): Promise<void> {
		if (this.indexDb.getState() !== "in_memory") return;
		await this.indexDb.whenRebuildComplete();
	}

	public async whenReady(): Promise<void> {
		await this.indexDb.whenFullyReady();
	}

	public isReady(): boolean {
		if (!this.indexDb.isReady()) return false;
		if (
			this.indexDb.getState() === "in_memory" &&
			this.indexDb.isRebuilding()
		) {
			return false;
		}
		return true;
	}

	public getIndexState(): "persistent" | "in_memory" | "unavailable" {
		return this.indexDb.getState();
	}

	public isIndexPersistent(): boolean {
		return this.indexDb.getState() === "persistent";
	}
}
