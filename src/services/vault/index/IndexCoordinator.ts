import {
	type App,
	type CachedMetadata,
	type Debouncer,
	debounce,
	Notice,
	type TAbstractFile,
	type TFile,
} from "obsidian";
import type { CacheManager, IterableCache } from "src/lib/cache";

import { isAbortError } from "src/lib/concurrency";
import { isErr, wrapResult } from "src/lib/core/result";
import type { IndexRepository } from "src/lib/database/indexRepository";
import type { ImportSourceRow } from "src/lib/database/types";
import type { AppResult } from "src/lib/errors/types";
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
import type { VaultBookScanner } from "../VaultBookScanner";
import type { IndexDatabase } from "./IndexDatabase";

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

	private readonly recentlyImportedPaths = new Set<string>();
	private rebuildController: AbortController | null = null;

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly indexDb: IndexDatabase,
		private readonly noteEditorService: NoteEditorService,
		private readonly fsService: FileSystemService,
		logging: LoggingService,
		cacheManager: CacheManager,
		private readonly vaultBookScanner: VaultBookScanner,
		private readonly indexRepo: IndexRepository,
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

	public async startBackgroundRebuild(): Promise<void> {
		// Cancel any existing rebuild before starting a new one.
		if (this.rebuildController) {
			this.rebuildController.abort();
		}

		const controller = new AbortController();
		const signal = controller.signal;

		this.rebuildController = controller;

		try {
			// Set initial status
			this.indexDb.setRebuildStatus({
				phase: "rebuilding",
				progress: { current: 0, total: 0 },
			});

			const batchSize = 64; // Same as ParallelIndexProcessor default
			const batch: import("src/types").BookMetadata[] = [];
			let processed = 0;

			const stream = this.vaultBookScanner.scanBooks({
				signal,
				onProgress: (current) => {
					processed = current;
					this.indexDb.setRebuildStatus({
						phase: "rebuilding",
						progress: { current, total: 0 },
					});
				},
			});

			for await (const item of stream) {
				if (isErr(item)) {
					// Log scan error but continue rebuilding
					this.log.warn(
						`Scan error during index rebuild: ${item.error.file.path}`,
						item.error.error,
					);
					continue;
				}

				const { metadata } = item.value;
				batch.push(metadata);
				if (batch.length >= batchSize) {
					await this.writeBatchToIndex(batch.splice(0, batch.length));
				}
			}

			// Write remaining items
			if (batch.length > 0) {
				await this.writeBatchToIndex(batch);
			}

			// Success
			this.indexDb.setRebuildStatus({ phase: "complete" });
			this.log.info("Index rebuild completed successfully");
		} catch (e) {
			if (isAbortError(e)) {
				this.indexDb.setRebuildStatus({ phase: "cancelled" });
				this.log.info("Index rebuild was cancelled");
			} else {
				this.indexDb.setRebuildStatus({ phase: "failed", error: e });
				this.log.error("Index rebuild failed", e);
				throw e;
			}
		} finally {
			this.rebuildController = null;
		}
	}

	private async writeBatchToIndex(
		batch: import("src/types").BookMetadata[],
	): Promise<void> {
		for (const { key, title, authors, vaultPath } of batch) {
			await this.indexRepo.upsertBookWithInstance(
				{ key, id: null, title, authors },
				vaultPath,
			);
		}
	}

	public async initialize(): Promise<void> {
		await this.indexDb.whenReady();
		this.registerVaultEvents();

		if (this.indexDb.getState() === "in_memory") {
			void this.startBackgroundRebuild();
		}
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
				// Cancel any ongoing rebuild for previous settings and start a new one.
				if (this.rebuildController) {
					this.rebuildController.abort();
				}
				void this.startBackgroundRebuild();
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
		if (isTFolder(file)) {
			await this.indexRepo.handleRenameFolder(oldPath, file.path);
		} else if (isTFile(file)) {
			const key = await this.findKeyByVaultPath(oldPath);
			await this.indexRepo.handleRenameFile(oldPath, file.path);
			if (key) {
				this.pathCache.delete(key);
			}
		}
	}

	public async handleDelete(file: TAbstractFile): Promise<void> {
		if (isTFile(file)) {
			const pathToDelete = file.path;
			const key = await this.findKeyByVaultPath(pathToDelete);
			const sourcePath =
				await this.indexRepo.deleteNoteAndResetSource(pathToDelete);
			if (sourcePath) {
				this.log.info(
					`Reset import status for source '${sourcePath}' due to deletion of note '${pathToDelete}'`,
				);
			}
			if (key) {
				this.pathCache.delete(key);
			}
		} else if (isTFolder(file)) {
			await this.indexRepo.deleteInstancesInFolder(file.path);
			// For folders, invalidate all as it may affect multiple entries
			this.invalidateIndexCaches();
		}
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

			if (!metadata) {
				const { changed, oldKey } = await this.indexRepo.deleteInstanceForFile(
					file.path,
				);
				if (changed && oldKey) {
					this.pathCache.delete(oldKey);
				}
			} else {
				const { changed, oldKey, newKey } =
					await this.indexRepo.upsertFromMetadata(file.path, {
						key: metadata.key,
						title: metadata.title,
						authors: metadata.authors,
					});
				if (changed) {
					if (oldKey) this.pathCache.delete(oldKey);
					if (newKey) this.pathCache.delete(newKey);
				}
			}
		} catch (e) {
			if (!isAbortError(e)) {
				this.log.warn("Failed handling metadata change", e);
			}
		}
	}

	public async getImportSource(path: string): Promise<ImportSourceRow | null> {
		await this.indexDb.whenReady();
		return this.indexRepo.getByPath(path);
	}

	public async getImportSourceSafe(
		path: string,
	): Promise<AppResult<ImportSourceRow | null>> {
		return wrapResult(
			async () => {
				await this.indexDb.whenReady();
				return this.indexRepo.getByPath(path);
			},
			(e) =>
				({
					kind: "DbOperationFailed",
					operation: "getImportSource",
					cause: e,
				}) as const,
		);
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
		await this.indexRepo.recordImportSuccess(params);

		if (params.bookKey) {
			this.pathCache.delete(params.bookKey);
		}

		if (params.vaultPath) {
			this.recentlyImportedPaths.add(params.vaultPath);
			// TTL of 3000ms to guard against redundant metadata updates triggered by the import itself,
			// providing resilience under slow or bursty environments.
			setTimeout(() => {
				this.recentlyImportedPaths.delete(params.vaultPath!);
			}, 3000);
		}
	}

	public async recordImportSuccessSafe(params: {
		path: string;
		mtime: number;
		size: number;
		newestAnnotationTs: string | null;
		bookKey?: string | null;
		md5?: string | null;
		vaultPath?: string | null;
		title?: string;
		authors?: string;
	}): Promise<AppResult<void>> {
		return wrapResult(
			async () => {
				await this.indexRepo.recordImportSuccess(params);

				if (params.bookKey) {
					this.pathCache.delete(params.bookKey);
				}

				if (params.vaultPath) {
					this.recentlyImportedPaths.add(params.vaultPath);
					setTimeout(() => {
						this.recentlyImportedPaths.delete(params.vaultPath!);
					}, 3000);
				}
			},
			(e) =>
				({
					kind: "DbOperationFailed",
					operation: "recordImportSuccess",
					cause: e,
				}) as const,
		);
	}

	public async recordImportFailure(
		path: string,
		error: unknown,
	): Promise<void> {
		await this.indexRepo.recordImportFailure(path, error);
	}

	public async recordImportFailureSafe(
		path: string,
		error: unknown,
	): Promise<AppResult<void>> {
		return wrapResult(
			() => this.indexRepo.recordImportFailure(path, error),
			(e) =>
				({
					kind: "DbOperationFailed",
					operation: "recordImportFailure",
					cause: e,
				}) as const,
		);
	}

	public async deleteImportSource(path: string): Promise<void> {
		await this.indexRepo.deleteByPath(path);
	}

	public async deleteImportSourceSafe(path: string): Promise<AppResult<void>> {
		return wrapResult(
			() => this.indexRepo.deleteByPath(path),
			(e) =>
				({
					kind: "DbOperationFailed",
					operation: "deleteImportSource",
					cause: e,
				}) as const,
		);
	}

	public async clearImportSource(): Promise<void> {
		await this.indexRepo.clearAll();
	}

	public async clearImportSourceSafe(): Promise<AppResult<void>> {
		return wrapResult(
			() => this.indexRepo.clearAll(),
			(e) =>
				({
					kind: "DbOperationFailed",
					operation: "clearImportSource",
					cause: e,
				}) as const,
		);
	}

	public async findExistingBookFiles(bookKey: string): Promise<string[]> {
		const cached = this.pathCache.get(bookKey);
		if (cached) return cached;

		await this.indexDb.whenReady();
		const paths = await this.indexRepo.findPathsByKey(bookKey);
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
		await this.indexRepo.upsertBookWithInstance(
			{ key, id, title, authors },
			vaultPath,
		);
		this.pathCache.delete(key);
	}

	public async findKeyByVaultPath(vaultPath: string): Promise<string | null> {
		try {
			await this.indexDb.whenReady();
			const key = await this.indexRepo.findKeyByPath(vaultPath);
			return key ?? null;
		} catch (error) {
			this.log.warn(`Failed to find book key for path ${vaultPath}: ${error}`);
			return null;
		}
	}

	public async deleteBookInstanceByPath(vaultPath: string): Promise<void> {
		const key = await this.findKeyByVaultPath(vaultPath);
		const changed = await this.indexRepo.deleteInstanceByPath(vaultPath);
		if (changed && key) this.pathCache.delete(key);
	}

	public async latestSourceForBook(bookKey: string): Promise<string | null> {
		await this.indexDb.whenReady();
		const raw = await this.indexRepo.latestSourceForBook(bookKey);
		return raw ? Pathing.stripRootFromDevicePath(raw) : null;
	}

	public async getImportSourcesByMd5(
		md5: string,
	): Promise<
		Array<{ source_path: string; book_key: string | null; md5: string | null }>
	> {
		await this.indexDb.whenReady();
		return this.indexRepo.getImportSourcesByMd5(md5);
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
			this.log.info("Index path cache invalidated");
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

	public async flushIndexSafe(): Promise<AppResult<void>> {
		this.persistIndexDebounced.cancel();
		return wrapResult(
			() => this.indexDb.flush(),
			(e) => ({ kind: "DbPersistFailed", path: "index.db", cause: e }) as const,
		);
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
}
