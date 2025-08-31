import {
	type App,
	type CachedMetadata,
	type Debouncer,
	debounce,
	Notice,
	type TAbstractFile,
	type TFile,
} from "obsidian";
import type { Database } from "sql.js";
import type { CacheManager, IterableCache } from "src/lib/cache";

import { isAbortError } from "src/lib/concurrency";
import { isErr } from "src/lib/core/result";
import { BookRepository } from "src/lib/database/bookRepository";
import { SourceRepository } from "src/lib/database/sourceRepository";
import type { ImportSourceRow } from "src/lib/database/types";
import {
	isMarkdownFile,
	isTFile,
	isTFolder,
} from "src/lib/obsidian/typeguards";
import { Pathing } from "src/lib/pathing";
import type KoreaderImporterPlugin from "src/main";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { NoteEditorService } from "src/services/parsing/NoteEditorService";
import type {
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import type { IndexDatabase } from "./IndexDatabase";
import { executeTyped, executeWrite, RowMappers } from "./schema";

export class IndexCoordinator implements SettingsObserver {
	private readonly log;
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
	private readonly recentlyImportedPaths = new Set<string>();

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly indexDb: IndexDatabase,
		private readonly noteEditorService: NoteEditorService,
		private readonly fsService: FileSystemService,
		logging: LoggingService,
		cacheManager: CacheManager,
	) {
		this.log = logging.scoped("IndexCoordinator");
		this.settings = this.plugin.settings;
		this.cacheManager = cacheManager;
		this.pathCache = this.cacheManager.createLru("db.path", 2000);

		this.persistIndexDebounced = debounce(
			() => void this.flushIndex().catch(() => {}),
			1500,
			true,
		);
		this.debouncedHandleMetadataChange = debounce(
			(
				file: TFile,
				data: string,
				cache: CachedMetadata,
				signal?: AbortSignal,
			) => void this._handleMetadataChange(file, data, cache, signal),
			400,
			true,
		);
	}

	private async executeBookQueries(
		queries: Array<{ sql: string; params: readonly unknown[] }>,
	): Promise<void> {
		await this._withIndexTx(async (db) => {
			for (const query of queries) {
				executeWrite(db, query);
			}
		});
	}

	private createRebuildWriter(): (
		batch: import("src/types").BookMetadata[],
	) => Promise<void> {
		return async (batch) => {
			const queries = batch.flatMap(({ key, title, authors, vaultPath }) =>
				BookRepository.upsertBookWithInstance(
					{ key, id: null, title, authors },
					vaultPath,
				),
			);
			await this.executeBookQueries(queries);
		};
	}

	public async initialize(): Promise<void> {
		await this.indexDb.whenReady();
		this.registerVaultEvents();

		if (this.indexDb.getState() === "in_memory") {
			this.subscribeRebuildUi();
			const writer = this.createRebuildWriter();
			void this.indexDb.startBackgroundRebuild({
				app: this.app,
				noteEditorService: this.noteEditorService,
				highlightsFolder: this.settings.highlightsFolder ?? "",
				writer: writer,
			});
		}
	}

	private subscribeRebuildUi(): void {
		this.unsubscribeRebuild?.();
		this.unsubscribeRebuild = this.indexDb.onRebuildStatus((s) => {
			switch (s.phase) {
				case "rebuilding": {
					if (!this.rebuildNotice) {
						this.rebuildNotice = new Notice("📚 Building temporary index…", 0);
					}
					const { current = 0, total = 0 } = s.progress ?? {};
					const message =
						total > 0
							? `📚 Building index: ${current}/${total} files (${Math.round((current / total) * 100)}%)`
							: `📚 Building index: ${current} files scanned...`;
					this.rebuildNotice.setMessage(message);
					break;
				}
				case "complete":
					this.safeHideNotice();
					new Notice("✅ Temporary index ready", 3000);
					break;
				case "failed":
					this.safeHideNotice();
					new Notice(
						"⚠️ Rebuild failed. Using slower duplicate detection",
						5000,
					);
					break;
				case "cancelled":
					this.safeHideNotice();
					new Notice("⏸ Index rebuild cancelled", 3000);
					break;
				case "idle":
				default:
					break;
			}
		});
	}

	private safeHideNotice(): void {
		try {
			this.rebuildNotice?.hide();
		} catch {}
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
				const writer = this.createRebuildWriter();
				void this.indexDb.startBackgroundRebuild({
					app: this.app,
					noteEditorService: this.noteEditorService,
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
		this.plugin.registerEvent(
			this.app.metadataCache.on("changed", this.debouncedHandleMetadataChange),
		);
	}

	public async handleRename(
		file: TAbstractFile,
		oldPath: string,
	): Promise<void> {
		this.invalidateIndexCaches();
		await this._withIndexTx(async (d) => {
			if (isTFolder(file)) {
				const renameQuery = BookRepository.handleRenameFolder(
					oldPath,
					file.path,
				);
				executeWrite(d, renameQuery);
			} else if (isTFile(file)) {
				const renameQuery = BookRepository.handleRenameFile(file.path, oldPath);
				executeWrite(d, renameQuery);
			}
		});
	}

	public async handleDelete(file: TAbstractFile): Promise<void> {
		this.invalidateIndexCaches();
		await this._withIndexTx(async (d) => {
			if (isTFile(file)) {
				const pathToDelete = file.path;
				const findKeyQuery = BookRepository.findKeyByPath(pathToDelete);
				const [bookKey] = executeTyped(d, findKeyQuery, RowMappers.bookKey);

				if (bookKey) {
					const latestSourceQuery =
						SourceRepository.latestSourceForBook(bookKey);
					const [sourcePath] = executeTyped(
						d,
						latestSourceQuery,
						RowMappers.sourcePath,
					);
					if (sourcePath) {
						executeWrite(d, SourceRepository.deleteByPath(sourcePath));
						this.log.info(
							`Reset import status for source '${sourcePath}' due to deletion of note '${pathToDelete}'`,
						);
					}
				}
				executeWrite(d, BookRepository.deleteInstanceByPath(pathToDelete)); // This triggers the GC
			} else if (isTFolder(file)) {
				executeWrite(d, {
					sql: `DELETE FROM book_instances WHERE vault_path LIKE ?`,
					params: [`${file.path}/%`] as const,
				});
			}
		});
	}

	private shouldSkipMetadataUpdate(path: string): boolean {
		return this.recentlyImportedPaths.has(path);
	}

	private async _handleMetadataChange(
		file: TFile,
		_data: string,
		_cache: CachedMetadata,
		signal?: AbortSignal,
	): Promise<void> {
		if (this.shouldSkipMetadataUpdate(file.path)) {
			this.log.info(
				`Skipping metadata update for recently imported file: ${file.path}`,
			);
			return;
		}

		try {
			signal?.throwIfAborted();
			if (
				!isMarkdownFile(file) ||
				!this.settings.highlightsFolder ||
				!file.path.startsWith(this.settings.highlightsFolder)
			) {
				return;
			}

			const metadata = await this.noteEditorService.extractMetadata(file);

			const result = await this._withIndexTx((d) => {
				const findKeyQuery = BookRepository.findKeyByPath(file.path);
				const bookKeys = executeTyped(d, findKeyQuery, RowMappers.bookKey);
				const oldKey = bookKeys[0] ?? null;
				if (!metadata) {
					if (oldKey) {
						const deleteInstanceQuery = BookRepository.deleteInstanceByPath(
							file.path,
						);
						executeWrite(d, deleteInstanceQuery);
					}
					return { changed: !!oldKey, oldKey, newKey: null };
				}

				const upsertQueries = BookRepository.upsertBookWithInstance(
					{
						key: metadata.key,
						id: null,
						title: metadata.title,
						authors: metadata.authors,
					},
					file.path,
				);
				for (const query of upsertQueries) {
					executeWrite(d, query);
				}
				return { changed: true, oldKey, newKey: metadata.key };
			});

			if (result.changed) {
				if (result.oldKey) this.pathCache.delete(result.oldKey);
				if (result.newKey) this.pathCache.delete(result.newKey);
			}
		} catch (e) {
			if (!isAbortError(e)) {
				this.log.warn("Failed handling metadata change", e);
			}
		}
	}

	public async getImportSource(path: string): Promise<ImportSourceRow | null> {
		await this.indexDb.whenReady();
		const query = SourceRepository.getByPath(path);
		const rows = await this.indexDb
			.getConcurrent()
			.execute((d) => executeTyped(d, query, RowMappers.importSource));
		return rows[0] ?? null;
	}

	public async recordImportSuccess(params: {
		path: string;
		mtime: number;
		size: number;
		newestAnnotationTs: string | null;
		bookKey?: string | null;
		md5?: string | null;
		vaultPath?: string | null;
		title?: string;
		authors?: string;
	}): Promise<void> {
		await this._withIndexTx((d) => {
			const upsertQuery = SourceRepository.upsertSuccess(
				params.path,
				params.mtime,
				params.size,
				params.newestAnnotationTs,
				params.bookKey ?? null,
				params.md5 ?? null,
			);
			executeWrite(d, upsertQuery);
			if (params.vaultPath && params.bookKey) {
				const book = {
					key: params.bookKey,
					id: null,
					title: params.title ?? "Untitled",
					authors: params.authors ?? "Unknown Author",
				};
				const queries = BookRepository.upsertBookWithInstance(
					book,
					params.vaultPath,
				);
				for (const query of queries) {
					executeWrite(d, query);
				}
			}
		});

		if (params.bookKey) {
			this.pathCache.delete(params.bookKey);
		}

		if (params.vaultPath) {
			this.recentlyImportedPaths.add(params.vaultPath);
			setTimeout(() => {
				this.recentlyImportedPaths.delete(params.vaultPath!);
			}, 1000);
		}
	}

	public async recordImportFailure(
		path: string,
		error: unknown,
	): Promise<void> {
		await this._withIndexTx((d) => {
			const upsertQuery = SourceRepository.upsertFailure(path, error);
			executeWrite(d, upsertQuery);
		});
	}

	public async deleteImportSource(path: string): Promise<void> {
		await this._withIndexTx((d) => {
			const deleteQuery = SourceRepository.deleteByPath(path);
			executeWrite(d, deleteQuery);
		});
	}

	public async clearImportSource(): Promise<void> {
		await this._withIndexTx((d) => {
			const clearQuery = SourceRepository.clearAll();
			executeWrite(d, clearQuery);
		});
	}

	public async findExistingBookFiles(bookKey: string): Promise<string[]> {
		const cached = this.pathCache.get(bookKey);
		if (cached) return cached;

		await this.indexDb.whenReady();
		const query = BookRepository.findPathsByKey(bookKey);
		const rows = await this.indexDb
			.getConcurrent()
			.execute((d) => executeTyped(d, query, RowMappers.vaultPath));
		const paths = rows;
		this.pathCache.set(bookKey, paths);
		return paths;
	}

	public async upsertBook(
		id: number | null,
		key: string,
		title: string,
		authors: string,
		vaultPath?: string,
	): Promise<void> {
		const queries = BookRepository.upsertBookWithInstance(
			{ key, id, title, authors },
			vaultPath,
		);
		await this.executeBookQueries(queries);
		this.pathCache.delete(key);
	}

	public async findKeyByVaultPath(vaultPath: string): Promise<string | null> {
		const findKeyQuery = BookRepository.findKeyByPath(vaultPath);
		try {
			await this.indexDb.whenReady();
			const bookKeys = await this.indexDb
				.getConcurrent()
				.execute((d) => executeTyped(d, findKeyQuery, RowMappers.bookKey));
			return bookKeys[0] ?? null;
		} catch (error) {
			this.log.warn(`Failed to find book key for path ${vaultPath}: ${error}`);
			return null;
		}
	}

	public async deleteBookInstanceByPath(vaultPath: string): Promise<void> {
		const key = await this.findKeyByVaultPath(vaultPath);
		const changed = await this._withIndexTx((d) => {
			const deleteQuery = BookRepository.deleteInstanceByPath(vaultPath);
			executeWrite(d, deleteQuery);
			return d.getRowsModified() > 0;
		});
		if (changed && key) this.pathCache.delete(key);
	}

	public async latestSourceForBook(bookKey: string): Promise<string | null> {
		await this.indexDb.whenReady();
		const query = SourceRepository.latestSourceForBook(bookKey);
		const sourcePaths = await this.indexDb
			.getConcurrent()
			.execute((d) => executeTyped(d, query, RowMappers.sourcePath));
		const raw = sourcePaths[0] ?? null;
		return raw ? Pathing.stripRootFromDevicePath(raw) : null;
	}

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

	public invalidateIndexCaches(): void {
		try {
			this.pathCache.clear();
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

	private async _withIndexTx<T>(
		operation: (db: Database) => T | Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		signal?.throwIfAborted();
		await this.indexDb.whenReady();
		const concurrentDb = this.indexDb.getConcurrent();
		const result = await concurrentDb.writeTx(operation);
		this.persistIndexDebounced();
		return result;
	}
}
