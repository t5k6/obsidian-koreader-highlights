import { promises as fsp } from "node:fs";
import type { Plugin, TFile, TFolder, Vault } from "obsidian";
import { YIELD_INTERVAL } from "src/constants";
import type { CacheManager, IterableCache } from "src/lib/cache";
import { toArray } from "src/lib/collections";
import {
	KeyedQueue,
	readWithRetry,
	removeWithRetry,
	renameWithRetry,
	writeBinaryWithRetry,
} from "src/lib/concurrency";
import { withFsRetry } from "src/lib/concurrency/retry";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import { safeParse } from "src/lib/core/validationUtils";
import { verifyWrittenFile } from "src/lib/data-integrity";
import { toFailure } from "src/lib/errors/mapper";
import type { AppFailure, FileSystemFailure } from "src/lib/errors/types";
import type { ObsidianAdapter } from "src/lib/obsidian/adapterTypes";
import { createExtensionFilter } from "src/lib/obsidian/fileFilters";
import { isTFile, isTFolder } from "src/lib/obsidian/typeguards";
import { Pathing, type ScanCacheKey, type VaultPath } from "src/lib/pathing";
import { depthFirstTraverse } from "src/lib/traversal";
import type { Cache } from "src/types";
import type { ImportWarning } from "./import/types";
import type { LoggingService } from "./LoggingService";

/* ------------------------------------------------------------------ */
/*                              TYPES                                 */
/* ------------------------------------------------------------------ */

export interface CreateFileResult {
	file: TFile;
	warnings: ImportWarning[];
}

function _shouldInvalidateScanCache(
	changedPath: VaultPath,
	key: ScanCacheKey,
): boolean {
	const { rootPath, recursive } = key;

	if (Pathing.isAncestor(changedPath, rootPath)) {
		return true;
	}

	if (Pathing.isAncestor(rootPath, changedPath)) {
		if (recursive) {
			return true;
		}
		const parentOfChange = Pathing.vaultDirname(changedPath);
		return String(parentOfChange) === String(rootPath);
	}

	return false;
}

// Type guard for NodeJS.ErrnoException to avoid type assertions
function isNodeErrnoException(e: unknown): e is NodeJS.ErrnoException {
	return e instanceof Error && "code" in e;
}

// Local cache entry wrapper for typed caches managed via CacheManager
interface CacheEntry<T> {
	value: T;
	timestamp: number;
}

// Result of folder scans used by walkFolder/getFilesInFolder
export interface FolderScanResult {
	files: TFile[];
	aborted: boolean;
}

export class FileSystemService {
	private readonly log;
	private readonly folderExistsCache!: Cache<string, CacheEntry<boolean>>;
	private readonly nodeStatsCache!: Cache<
		string,
		CacheEntry<Result<import("node:fs").Stats, FileSystemFailure>>
	>;
	private readonly keyedQueue = new KeyedQueue();
	private renameReplaceSupported: boolean | null = null;
	private loggedCapabilityOnce = false;
	private folderScanCache!: IterableCache<string, FolderScanResult>;
	private readonly adapter: ObsidianAdapter;

	constructor(
		private readonly vault: Vault,
		private readonly plugin: Plugin,
		private readonly cacheManager: CacheManager,
		private readonly loggingService: LoggingService,
	) {
		this.log = this.loggingService.scoped("FileSystemService");
		this.folderExistsCache = this.cacheManager.createMap("fs.folderExists");
		this.nodeStatsCache = this.cacheManager.createMap("fs.nodeStats");
		this.folderScanCache = this.cacheManager.createLru("fs.folderScan", 200);
		this.adapter = this.vault.adapter as ObsidianAdapter;
		this.registerVaultEvents();
	}

	/* ------------------------------------------------------------------ */
	/*                        STATIC HELPERS & UTILS                      */
	/* ------------------------------------------------------------------ */

	/**
	 * Normalize adapter/Node error shapes to a stable not-found predicate.
	 */
	public static isNotFound(err: unknown): boolean {
		// Fallback for raw Node errors
		const failure = toFailure(err, "");
		return failure.kind === "NotFound";
	}

	/* ------------------------------------------------------------------ */
	/*                     SCANNING / WALKING FOLDERS                      */
	/* ------------------------------------------------------------------ */

	public async getFilesInFolder(
		folderVaultPathOrFolder: string | TFolder,
		options?: {
			extensions?: string[];
			recursive?: boolean;
			signal?: AbortSignal;
		},
	): Promise<FolderScanResult> {
		const recursive = options?.recursive ?? true;
		const extensions = options?.extensions ?? ["md"];
		const signal = options?.signal;

		const rootPath =
			typeof folderVaultPathOrFolder === "string"
				? Pathing.toVaultPath(folderVaultPathOrFolder)
				: Pathing.toVaultPath(folderVaultPathOrFolder.path);

		const key = Pathing.generateScanCacheKey({
			rootPath,
			recursive,
			extensions,
		});
		const cached = this.folderScanCache.get(key);
		if (cached && !signal?.aborted) return cached;

		const files = await toArray(
			this.iterateVaultFiles(folderVaultPathOrFolder, {
				recursive,
				signal,
				extensions,
			}),
		);
		const res = { files, aborted: Boolean(signal?.aborted) };
		if (!res.aborted) this.folderScanCache.set(key, res);
		return res;
	}

	public async *iterateVaultFiles(
		folderVaultPathOrFolder: string | TFolder,
		opts?: { recursive?: boolean; signal?: AbortSignal; extensions?: string[] },
	): AsyncIterable<TFile> {
		const recursive = opts?.recursive ?? true;
		const signal = opts?.signal;

		const folderPath =
			typeof folderVaultPathOrFolder === "string"
				? Pathing.toVaultPath(folderVaultPathOrFolder)
				: folderVaultPathOrFolder.path;

		const rootAbs =
			typeof folderVaultPathOrFolder === "string"
				? this.vault.getAbstractFileByPath(folderPath)
				: folderVaultPathOrFolder;

		if (!isTFolder(rootAbs)) return;

		const filter = opts?.extensions?.length
			? createExtensionFilter(opts.extensions)
			: null;

		let yielded = 0;
		for (const node of depthFirstTraverse(rootAbs, { recursive, signal })) {
			if (signal?.aborted) return;
			if (isTFile(node) && (!filter || filter(node))) {
				yield node;
				yielded++;
				if (yielded % YIELD_INTERVAL === 0) await Promise.resolve();
			}
		}
	}

	/**
	 * Stream files under a folder without materializing the full list in memory.
	 * This is the scalable, memory-efficient way to process large folders.
	 * Respects AbortSignal for immediate cancellation. Yields in DFS order.
	 */
	public async *iterateMarkdownFiles(
		folderVaultPathOrFolder: string | TFolder,
		opts?: { recursive?: boolean; signal?: AbortSignal },
	): AsyncIterable<TFile> {
		yield* this.iterateVaultFiles(folderVaultPathOrFolder, {
			...opts,
			extensions: ["md"],
		});
	}

	private registerVaultEvents(): void {
		// Invalidate scan cache when vault changes that can affect folder contents occur.
		// We intentionally type parameters as unknown here and guard at runtime.
		this.plugin.registerEvent(
			this.vault.on("create", (file: unknown) => {
				if (file && typeof (file as any).path === "string") {
					this.invalidateCacheFor((file as any).path);
				}
			}),
		);
		this.plugin.registerEvent(
			this.vault.on("delete", (file: unknown) => {
				if (file && typeof (file as any).path === "string") {
					this.invalidateCacheFor((file as any).path);
				}
			}),
		);
		this.plugin.registerEvent(
			this.vault.on("rename", (file: unknown, oldPath: unknown) => {
				// Invalidate both old and new locations
				if (typeof oldPath === "string") {
					this.invalidateCacheFor(oldPath);
				}
				if (file && typeof (file as any).path === "string") {
					this.invalidateCacheFor((file as any).path);
				}
			}),
		);
	}

	private invalidateCacheFor(vaultPath: string): void {
		if (!this.folderScanCache) return;
		const changed = Pathing.toVaultPath(vaultPath);

		this.folderScanCache.deleteWhere((rawKey: string) => {
			const key = Pathing.parseScanCacheKey(String(rawKey));
			return _shouldInvalidateScanCache(changed, key);
		});
	}

	/* ------------------------------------------------------------------ */
	/*                     PLUGIN DATA (ADAPTER-BASED)                    */
	/* ------------------------------------------------------------------ */

	/**
	 * Returns the plugin data directory as a vault-relative path:
	 * .obsidian/plugins/<pluginId>
	 * Always normalized and without leading slash.
	 */
	public getPluginDataDir(): VaultPath {
		// Obsidian's Vault has configDir in app.vault; some environments/mocks may not.
		const cfg =
			(this.vault as Vault & { configDir?: string }).configDir ?? ".obsidian";
		return Pathing.toVaultPath(`${cfg}/plugins/${this.plugin.manifest.id}`);
	}

	/**
	 * Joins segments inside the plugin data dir and returns a vault-relative path.
	 */
	public joinPluginDataPath(...segments: string[]): VaultPath {
		return Pathing.joinVaultPath(this.getPluginDataDir(), ...segments);
	}

	private renameReplaceProbePromise: Promise<boolean> | null = null;

	private async probeRenameReplaceSupport(): Promise<boolean> {
		if (this.renameReplaceSupported !== null)
			return this.renameReplaceSupported;
		if (this.renameReplaceProbePromise) return this.renameReplaceProbePromise;

		this.renameReplaceProbePromise = this.keyedQueue.run(
			"__probe_rename_replace__",
			async () => {
				if (this.renameReplaceSupported !== null)
					return this.renameReplaceSupported;
				const ensured = await this.ensurePluginDataDir();
				if (isErr(ensured)) {
					// safest default: assume not supported on unusual adapters
					this.renameReplaceSupported = false;
					return this.renameReplaceSupported;
				}

				const dir = this.getPluginDataDir();
				const a = Pathing.joinVaultPath(dir, `.__probe_a__${Date.now()}`);
				const b = Pathing.joinVaultPath(dir, `.__probe_b__${Date.now()}`);
				try {
					await this.vault.adapter.write(a, "a");
					await this.vault.adapter.write(b, "b");
					try {
						await this.vault.adapter.rename(a, b);
						this.renameReplaceSupported = true;
					} catch {
						this.renameReplaceSupported = false;
					}
				} finally {
					await this.vault.adapter.remove(a).catch(() => {});
					await this.vault.adapter.remove(b).catch(() => {});
				}
				if (
					this.renameReplaceSupported === false &&
					!this.loggedCapabilityOnce
				) {
					this.log.info(
						"Adapter does not support rename-over-existing; using swap fallback.",
					);
					this.loggedCapabilityOnce = true;
				}
				return this.renameReplaceSupported;
			},
		);

		return this.renameReplaceProbePromise;
	}

	/**
	 * Read binary file via the vault adapter using a vault-relative path.
	 * Result-based API.
	 */
	public async readVaultBinary(
		vaultPath: string,
	): Promise<Result<Uint8Array, AppFailure>> {
		const p = Pathing.toVaultPath(vaultPath);
		try {
			const data = await readWithRetry(this.vault.adapter, p, {
				maxAttempts: 5,
				baseDelayMs: 30,
			});
			return ok(new Uint8Array(data));
		} catch (e: unknown) {
			return err(toFailure(e, p, "ReadFailed"));
		}
	}

	/**
	 * Write binary file via the vault adapter using a vault-relative path.
	 * Result-based API. Ensures parent directory exists.
	 */
	public async writeVaultBinary(
		vaultPath: string,
		data: Uint8Array,
	): Promise<Result<void, AppFailure>> {
		const p = Pathing.toVaultPath(vaultPath);
		const ensured = await this.ensureParentDirectory(p);
		if (isErr(ensured)) return ensured;
		try {
			const arrayBuffer = data.buffer.slice(
				data.byteOffset,
				data.byteOffset + data.byteLength,
			) as ArrayBuffer;
			await writeBinaryWithRetry(this.vault.adapter, p, arrayBuffer, {
				maxAttempts: 4,
				baseDelayMs: 30,
			});
			return ok(void 0);
		} catch (e: unknown) {
			return err(toFailure(e, p, "WriteFailed"));
		}
	}

	/**
	 * Atomically write a binary file. Result-based.
	 */
	public async writeVaultBinaryAtomic(
		vaultPath: string,
		data: Uint8Array,
	): Promise<Result<void, AppFailure>> {
		const dst = Pathing.toVaultPath(vaultPath);
		const ensured = await this.ensureParentDirectory(dst);
		if (isErr(ensured)) return ensured;

		return this.keyedQueue.run(`atomic:${dst}`, async () => {
			const tmp = Pathing.toVaultPath(
				`${dst}.__tmp__${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			try {
				const arrayBuffer = data.buffer.slice(
					data.byteOffset,
					data.byteOffset + data.byteLength,
				) as ArrayBuffer;
				await writeBinaryWithRetry(this.vault.adapter, tmp, arrayBuffer, {
					maxAttempts: 4,
					baseDelayMs: 30,
				});

				// --- PRE-COMMIT VERIFICATION ---
				// Verify the temporary file's content *before* the atomic rename.
				const preCommitCheck = await verifyWrittenFile(
					this.vault.adapter,
					tmp,
					arrayBuffer,
				);
				if (isErr(preCommitCheck)) {
					this.log.error(
						`Pre-commit verification failed for ${tmp}. Aborting write.`,
						preCommitCheck.error,
					);
					return preCommitCheck; // Abort: do not attempt rename if tmp is corrupted.
				}
				// --- END VERIFICATION ---

				const replaceSupported = await this.probeRenameReplaceSupport();
				if (replaceSupported) {
					try {
						await renameWithRetry(this.vault.adapter, tmp, dst, {
							maxAttempts: 6,
							baseDelayMs: 30,
						});
						return ok(void 0);
					} catch {
						// Fall back to swap on rare failure
					}
				}
				// The backup-swap fallback remains as a secondary defense mechanism.
				// Its own internal verification can be updated to use the new utility as well.
				// For this change, we will pass the expected data down.
				return await this.replaceViaBackupSwapResult(dst, tmp, arrayBuffer);
			} catch (e: unknown) {
				return err(toFailure(e, dst, "WriteFailed"));
			} finally {
				try {
					await this.vault.adapter.remove(tmp);
				} catch {}
			}
		});
	}

	private async replaceViaBackupSwapResult(
		dst: VaultPath,
		tmp: VaultPath,
		originalData: ArrayBuffer,
	): Promise<Result<void, AppFailure>> {
		const bak = Pathing.toVaultPath(`${dst}.__bak__`);
		try {
			await this.vault.adapter.remove(bak);
		} catch {}

		if (await this.vault.adapter.exists(dst)) {
			try {
				await renameWithRetry(this.vault.adapter, dst, bak);
			} catch (e) {
				// If we can't create a backup, it's safer to fail than risk data loss.
				return err(toFailure(e, dst, "WriteFailed"));
			}
		}

		try {
			await renameWithRetry(this.vault.adapter, tmp, dst);

			const verifyResult = await verifyWrittenFile(
				this.vault.adapter,
				dst,
				originalData as ArrayBuffer,
			);
			if (isErr(verifyResult)) {
				this.log.error(
					`Atomic write verification failed for ${dst}. Attempting to restore from backup.`,
					verifyResult.error,
				);
				// Attempt to restore the backup
				if (await this.vault.adapter.exists(bak)) {
					try {
						await renameWithRetry(this.vault.adapter, bak, dst);
						this.log.info(`Successfully restored backup for ${dst}.`);
					} catch (restoreErr) {
						this.log.error(
							`CRITICAL: Failed to restore backup for ${dst} after write failure. Data may be corrupt.`,
							restoreErr,
						);
					}
				}
				return verifyResult; // Return the original verification failure
			}

			try {
				await this.vault.adapter.remove(bak);
			} catch {}
			return ok(void 0);
		} catch (placeErr: any) {
			// If the final rename fails, restore the backup
			if (await this.vault.adapter.exists(bak)) {
				try {
					await renameWithRetry(this.vault.adapter, bak, dst);
				} catch {}
			}
			return err(toFailure(placeErr, dst, "WriteFailed"));
		} finally {
			try {
				await this.vault.adapter.remove(tmp);
			} catch {}
		}
	}

	/** Result-based write of UTF-8 text atomically. */
	public async writeVaultTextAtomic(
		vaultPath: string,
		content: string,
	): Promise<Result<void, AppFailure>> {
		const buffer = new TextEncoder().encode(content);
		return this.writeVaultBinaryAtomic(Pathing.toVaultPath(vaultPath), buffer);
	}

	/** Result-based append of UTF-8 text to an existing vault file (creates parent dirs if needed). */
	public async appendVaultText(
		vaultPath: string,
		text: string,
	): Promise<Result<void, AppFailure>> {
		const p = Pathing.toVaultPath(vaultPath);
		const ensured = await this.ensureParentDirectory(p);
		if (isErr(ensured)) return ensured;

		return this.keyedQueue.run(`append:${p}`, async () => {
			try {
				if (typeof this.vault.adapter.append === "function") {
					await withFsRetry(
						() =>
							(
								this.vault.adapter.append as NonNullable<
									typeof this.vault.adapter.append
								>
							)(p, text),
						{
							maxAttempts: 6,
							baseDelayMs: 40,
						},
					);
				} else {
					// Fallback
					const existing = await this.readVaultText(p);
					if (isErr(existing)) {
						if (existing.error.kind === "NotFound") {
							await withFsRetry(() => this.vault.adapter.write(p, text), {
								maxAttempts: 6,
								baseDelayMs: 40,
							});
						} else {
							return err(existing.error);
						}
					} else {
						await withFsRetry(
							() => this.vault.adapter.write(p, existing.value + text),
							{
								maxAttempts: 6,
								baseDelayMs: 40,
							},
						);
					}
				}
				return ok(void 0);
			} catch (e: unknown) {
				return err(toFailure(e, p, "WriteFailed"));
			}
		});
	}

	/** Result-based read of UTF-8 text from vault. */
	public async readVaultText(
		vaultPath: string,
	): Promise<Result<string, AppFailure>> {
		const bin = await this.readVaultBinary(Pathing.toVaultPath(vaultPath));
		if (isErr(bin)) return bin;
		try {
			return ok(new TextDecoder().decode(bin.value));
		} catch (e: unknown) {
			const p = Pathing.toVaultPath(vaultPath);
			return err({ kind: "ReadFailed", path: p, cause: e });
		}
	}

	/**
	 * Result-based read of a TFile's text content using Obsidian's Vault API with retry.
	 * Centralizes retry policy for higher-level vault reads.
	 */
	public async readVaultTextWithRetry(
		file: TFile,
	): Promise<Result<string, AppFailure>> {
		try {
			const text = await withFsRetry(() => this.vault.read(file), {
				maxAttempts: 5,
				baseDelayMs: 30,
			});
			return ok(text);
		} catch (e: unknown) {
			return err(toFailure(e, file.path, "ReadFailed"));
		}
	}

	/**
	 * Result-based modify (write) of a TFile's text content using Obsidian's Vault API with retry.
	 * Centralizes retry policy for higher-level vault writes.
	 */
	public async modifyVaultFileWithRetry(
		file: TFile,
		content: string,
	): Promise<Result<TFile, AppFailure>> {
		try {
			await withFsRetry(() => this.vault.modify(file, content), {
				maxAttempts: 6,
				baseDelayMs: 40,
			});
			return ok(file);
		} catch (e: unknown) {
			return err(toFailure(e, file.path, "WriteFailed"));
		}
	}

	/* ------------------------------------------------------------------ */
	/*                         AUTO-ROUTING HELPERS                        */
	/* ------------------------------------------------------------------ */

	/** Result-based read of binary (auto-route vault vs node). */
	async readBinaryAuto(
		filePath: string,
	): Promise<Result<Uint8Array, AppFailure>> {
		if (Pathing.isSystemPath(filePath)) {
			// Calls the new, clean, purpose-built method. Much clearer!
			return this.readNodeFileBinary(filePath);
		} else {
			return this.readVaultBinary(filePath);
		}
	}

	/** Result-based write of binary (auto-route vault vs node). */
	public async writeBinaryAuto(
		filePath: string,
		data: Uint8Array,
	): Promise<Result<void, AppFailure>> {
		if (Pathing.isSystemPath(filePath)) {
			const result = await this.writeNodeFile(filePath, data);
			if (isErr(result)) {
				// Map FileSystemFailure to AppFailure
				return err(result.error as unknown as AppFailure);
			}
			return ok(void 0);
		} else {
			return this.writeVaultBinary(filePath, data);
		}
	}

	/* ------------------------------------------------------------------ */
	/*                         VAULT OPERATIONS                           */
	/* ------------------------------------------------------------------ */

	/**
	 * Wrapper for getAbstractFileByPath that returns TFile | null.
	 */
	private getTFileByPath(vaultPath: string): TFile | null {
		const abs = this.vault.getAbstractFileByPath(vaultPath);
		return isTFile(abs) ? abs : null;
	}

	/** Result-based write of UTF-8 text to a vault path (create or modify). */
	public async writeVaultFile(
		vaultPath: string,
		content: string,
	): Promise<Result<TFile, AppFailure>> {
		const p = Pathing.toVaultPath(vaultPath);
		const ensured = await this.ensureParentDirectory(p);
		if (isErr(ensured)) return err(ensured.error);
		const existing = this.getTFileByPath(p);
		if (existing) {
			const r = await this.modifyVaultFileWithRetry(existing, content);
			if (isErr(r)) return err(r.error);
			return ok(r.value);
		}
		// Create new file with retry; on EEXIST race, fallback to modify with retry
		try {
			const created = await withFsRetry(() => this.vault.create(p, content), {
				maxAttempts: 3,
				baseDelayMs: 30,
			});
			return ok(created);
		} catch (e: unknown) {
			const code =
				(e as unknown as { code?: string; Code?: string })?.code ??
				(e as unknown as { code?: string; Code?: string })?.Code;
			if (code === "EEXIST") {
				const now = this.getTFileByPath(p);
				if (now) {
					const r = await this.modifyVaultFileWithRetry(now, content);
					if (isErr(r)) return err(r.error);
					return ok(r.value);
				}
			}
			return err(toFailure(e, p, "WriteFailed"));
		}
	}

	public async ensurePluginDataDir(): Promise<Result<void, AppFailure>> {
		const dir = this.getPluginDataDir();
		return this.ensureAdapterFolder(dir);
	}

	/** Result-based list of a vault directory (canonical). */
	public async listVaultDir(
		vaultPath: string,
	): Promise<Result<{ files: string[]; folders: string[] }, AppFailure>> {
		const dir = Pathing.toVaultPath(vaultPath);
		try {
			const r = await this.vault.adapter.list(dir);
			return ok(r);
		} catch (e: unknown) {
			return err(toFailure(e, dir, "ReadFailed"));
		}
	}

	/** Result-based remove of a vault path (canonical). */
	public async removeVaultPath(
		vaultPath: string,
		opts?: { ignoreNotFound?: boolean },
	): Promise<Result<void, AppFailure>> {
		const p = Pathing.toVaultPath(vaultPath);
		try {
			await removeWithRetry(this.vault.adapter, p, {
				maxAttempts: 3,
				baseDelayMs: 25,
			});
			return ok(void 0);
		} catch (e: unknown) {
			const f = toFailure(e, p, "WriteFailed");
			if (opts?.ignoreNotFound && f.kind === "NotFound") return ok(void 0);
			return err(f);
		}
	}

	/** Result-based rename of a vault path with retry. */
	public async renameVaultPath(
		fromPath: string,
		toPath: string,
	): Promise<Result<void, AppFailure>> {
		const from = Pathing.toVaultPath(fromPath);
		const to = Pathing.toVaultPath(toPath);
		const ensured = await this.ensureParentDirectory(to);
		if (isErr(ensured)) return ensured;
		try {
			await renameWithRetry(this.vault.adapter, from, to, {
				maxAttempts: 6,
				baseDelayMs: 30,
			});
			return ok(void 0);
		} catch (e: unknown) {
			return err(toFailure(e, from, "WriteFailed"));
		}
	}

	public async vaultExists(
		vaultPath: string,
	): Promise<Result<boolean, AppFailure>> {
		const p = Pathing.toVaultPath(vaultPath);
		try {
			const exists = await this.vault.adapter.exists(p);
			return ok(Boolean(exists));
		} catch (e: unknown) {
			const failure = toFailure(e, p, "ReadFailed");
			// For an "exists" check, NotFound is a valid outcome, not an error.
			if (failure.kind === "NotFound") {
				return ok(false);
			}
			return err(failure);
		}
	}

	/* ---------------- Plugin-data helpers (text/json, atomic) ---------------- */

	public async readPluginDataText(
		fileName: string,
	): Promise<Result<string, AppFailure>> {
		const p = this.joinPluginDataPath(fileName);
		return this.readVaultText(p);
	}

	public async writePluginDataTextAtomic(
		fileName: string,
		content: string,
	): Promise<Result<void, AppFailure>> {
		const ensured = await this.ensurePluginDataDir();
		if (isErr(ensured)) return ensured;
		const p = this.joinPluginDataPath(fileName);
		return this.writeVaultTextAtomic(p, content);
	}

	public async writePluginDataJsonAtomic(
		fileName: string,
		obj: unknown,
	): Promise<Result<void, AppFailure>> {
		const json = JSON.stringify(obj, null, 2);
		return this.writePluginDataTextAtomic(fileName, json);
	}

	public async tryReadPluginDataJson<T = unknown>(
		fileName: string,
	): Promise<T | null> {
		const r = await this.readPluginDataText(fileName);
		if (isErr(r)) {
			// Use type-safe check for NotFound
			if (r.error.kind === "NotFound") return null;
			return null;
		}
		const parsed = safeParse<T>(r.value);
		return parsed;
	}

	public async existsPluginData(relPath: string): Promise<boolean> {
		const p = this.joinPluginDataPath(relPath);
		const r = await this.vaultExists(p);
		return isErr(r) ? false : r.value;
	}

	public async listPluginDataDir(): Promise<
		Result<{ files: string[]; folders: string[] }, AppFailure>
	> {
		const dir = this.getPluginDataDir();
		return this.listVaultDir(dir);
	}

	public async removePluginDataPath(
		relPath: string,
	): Promise<Result<void, AppFailure>> {
		const p = this.joinPluginDataPath(relPath);
		return this.removeVaultPath(p);
	}

	public async ensureVaultFolder(
		folderPath: string,
	): Promise<Result<void, AppFailure>> {
		const normalized = Pathing.toVaultPath(folderPath);
		if (!normalized) return ok(void 0);

		// Use a keyed queue to prevent race conditions when this is called
		// for the same path concurrently from different parts of the plugin.
		return this.keyedQueue.run(`folder:${normalized}`, async () => {
			// Check cache first for performance
			const cached = this.folderExistsCache.get(normalized);
			if (cached) return ok(void 0);

			// 1. Explicitly check for an existing file/folder at the path.
			const abstract = this.vault.getAbstractFileByPath(normalized);

			// 2. If it's already a folder, our job is done. This is a success.
			if (isTFolder(abstract)) {
				this.folderExistsCache.set(normalized, {
					value: true,
					timestamp: Date.now(),
				});
				return ok(void 0);
			}

			// 3. If a file exists at that path, it's an error. We cannot create a folder.
			if (abstract) {
				// This implies it's a TFile
				return err({ kind: "NotADirectory", path: normalized });
			}

			// 4. Only if the path is clear, we attempt to create the folder.
			try {
				await this.vault.createFolder(normalized);
				this.folderExistsCache.set(normalized, {
					value: true,
					timestamp: Date.now(),
				});
				return ok(void 0);
			} catch (error: unknown) {
				// This catch block now only handles genuine creation errors (like permissions)
				// or rare race conditions where the folder was created between our check and now.
				return this.handleMkdirError(error, normalized);
			}
		});
	}

	public async ensureParentDirectory(
		filePath: string,
	): Promise<Result<void, AppFailure>> {
		const parentDir = Pathing.vaultDirname(filePath);
		if (!parentDir) return ok(void 0);
		return this.ensureVaultFolder(parentDir);
	}

	/**
	 * Resolve a vault path to a TFolder with optional ensure.
	 * - ensure = true will attempt to create the folder if missing.
	 */
	public async resolveVaultFolder(
		folderPath: string,
		opts?: { ensure?: boolean },
	): Promise<Result<TFolder, AppFailure>> {
		const p = Pathing.toVaultPath(folderPath);
		if (!p) return err({ kind: "ConfigMissing", field: "folderPath" });

		if (opts?.ensure) {
			const ensured = await this.ensureVaultFolder(p);
			if (isErr(ensured)) return err(ensured.error);
		}

		const af = this.vault.getAbstractFileByPath(p);
		if (!af) return err({ kind: "NotFound", path: p });
		if (!isTFolder(af)) return err({ kind: "NotADirectory", path: p });
		return ok(af);
	}

	/** Thin wrapper that accepts either a TFolder or a path. */
	public async listMarkdownFiles(
		folder: string | TFolder,
		opts?: { recursive?: boolean; signal?: AbortSignal },
	): Promise<TFile[]> {
		const res = await this.getFilesInFolder(folder, {
			extensions: ["md"],
			recursive: opts?.recursive ?? true,
			signal: opts?.signal,
		});
		return res.files;
	}

	// Adapter mkdir chain as Result
	private async ensureAdapterFolder(
		vaultRelPath: string,
	): Promise<Result<void, AppFailure>> {
		const normalized = Pathing.toVaultPath(vaultRelPath);
		if (!normalized) return ok(void 0);

		return this.keyedQueue.run(`folder-adapter:${normalized}`, async () => {
			try {
				// Fast path: check if the final directory already exists.
				const exists = await this.adapter.exists(normalized, true);
				if (exists) {
					if (typeof this.adapter.stat === "function") {
						const stat = await this.adapter.stat(normalized);
						if (stat?.type === "folder") return ok(void 0);
						if (stat?.type === "file")
							return err({ kind: "NotADirectory", path: normalized });
					} else {
						// If .stat() doesn't exist, we can't definitively check if it's a folder.
						// We assume if it exists, it's the folder we want. This maintains original behavior.
						return ok(void 0);
					}
				}

				// Slow path: Create parent directories one by one. This is the most reliable way.
				const segments = normalized.split("/");
				let current = "";
				for (const seg of segments) {
					current = current ? `${current}/${seg}` : seg;
					// eslint-disable-next-line no-await-in-loop
					if (!(await this.adapter.exists(current, true))) {
						// eslint-disable-next-line no-await-in-loop
						await this.adapter.mkdir(current);
					}
				}
				return ok(void 0);
			} catch (error: unknown) {
				// The catch block will now use our resilient error mapping.
				return this.handleMkdirError(error, normalized);
			}
		});
	}

	public async createVaultFileUnique(
		baseDir: string,
		desiredStem: string,
		content: string,
		ext: string = "md",
	): Promise<Result<CreateFileResult, AppFailure>> {
		const dir = Pathing.toVaultPath(baseDir);
		const safeStem = Pathing.toFileSafe(desiredStem, { fallback: "Untitled" });

		return this.keyedQueue.run(`file:${dir}/${safeStem}`, async () => {
			const ensured = await this.ensureVaultFolder(dir);
			if (isErr(ensured)) {
				return ensured;
			}

			// Define the existence check callback for the pure function.
			// This is the "Shell" providing the "Core" with its I/O capability.
			const existsCheck = async (
				candidatePath: VaultPath,
			): Promise<boolean> => {
				const result = await this.vaultExists(candidatePath);
				return !isErr(result) && result.value;
			};

			const absVaultBase = this.getVaultAbsoluteBasePath();

			const { stem: finalStem, wasTruncated } =
				await Pathing.generateUniqueStem(safeStem, existsCheck, {
					baseDir: dir,
					ext,
					absVaultBase,
					targetMaxPathLen: 255,
					suffixReserve: 10,
				});

			const finalPath = Pathing.joinVaultPath(
				dir,
				`${finalStem}.${ext.replace(/^\./, "")}`,
			);

			try {
				const createdFile = await this.vault.create(finalPath, content);

				// On success, return the new structured result with warnings.
				const warnings: ImportWarning[] = wasTruncated
					? [
							{
								code: "FILENAME_TRUNCATED", // This is now checked against WarningCode
								message:
									"A filename was too long and has been automatically shortened.",
							},
						]
					: [];
				return ok({ file: createdFile, warnings });
			} catch (error: unknown) {
				// If creation fails, map it to our structured error type.
				return err(toFailure(error, finalPath, "WriteFailed"));
			}
		});
	}

	/**
	 * Atomically checks for and returns a TFile for the requested stem within a keyed lock.
	 * Eliminates the race condition of checking for existence and then getting the file.
	 * @returns The TFile if it exists, otherwise null.
	 */
	public async getFileIfExistsUnderLock(
		baseDir: string,
		desiredStem: string,
		ext: string = "md",
	): Promise<TFile | null> {
		const dir = Pathing.toVaultPath(baseDir);
		const stem = Pathing.toFileSafe(desiredStem, {
			fallback: "",
			maxLength: 0,
		});
		const e = ext.replace(/^\./, "");

		return this.keyedQueue.run(`file:${dir}/${stem}`, async () => {
			const candidatePath = Pathing.joinVaultPath(dir, `${stem}.${e}`);
			const abs = this.vault.getAbstractFileByPath(candidatePath);
			return isTFile(abs) ? abs : null;
		});
	}

	/**
	 * Generates a suggestion for a unique filename stem.
	 * WARNING: This method is for UI previews only. Do NOT use its return value
	 * to create a file directly, as a race condition could occur.
	 * Use createVaultFileUnique() for safe file creation.
	 */
	public async previewUniqueStem(
		baseDir: string,
		desiredStem: string,
	): Promise<string> {
		const dir = Pathing.toVaultPath(baseDir);
		const safeStem = Pathing.toFileSafe(desiredStem, {
			fallback: "",
			maxLength: 0,
		});

		const checkVaultExistence = async (
			candidatePath: VaultPath,
		): Promise<boolean> => {
			const result = await this.vaultExists(candidatePath);
			return !isErr(result) && result.value;
		};

		// Delegate to the pure function
		const { stem } = await Pathing.generateUniqueStem(
			safeStem,
			checkVaultExistence,
			{ baseDir: dir, ext: "md" },
		);

		return stem;
	}

	/* ------------------------------------------------------------------ */
	/*                         NODE.JS OPERATIONS                         */
	/* ------------------------------------------------------------------ */

	public async nodeFileExists(filePath: string): Promise<boolean> {
		try {
			await withFsRetry(() => fsp.access(filePath));
			return true;
		} catch {
			return false;
		}
	}

	/** Result-based file read (replaces old readNodeFile). */
	public async readNodeFileText(
		filePath: string,
	): Promise<Result<string, FileSystemFailure>> {
		try {
			const data = await withFsRetry(() => fsp.readFile(filePath, "utf-8"));
			return ok(data);
		} catch (error: unknown) {
			return err(toFailure(error, filePath, "ReadFailed"));
		}
	}

	public async readNodeFileBinary(
		filePath: string,
	): Promise<Result<Uint8Array, FileSystemFailure>> {
		try {
			const data = await withFsRetry(() => fsp.readFile(filePath));
			return ok(data as Uint8Array);
		} catch (error: unknown) {
			return err(toFailure(error, filePath, "ReadFailed"));
		}
	}

	public async writeNodeFile(
		filePath: string,
		data: string | Uint8Array,
	): Promise<Result<void, FileSystemFailure>> {
		try {
			await withFsRetry(async () => {
				await fsp.mkdir(Pathing.systemDirname(filePath), { recursive: true });
				await fsp.writeFile(filePath, data);
			});
			this.nodeStatsCache.delete(filePath);
			return ok(void 0);
		} catch (error: unknown) {
			return err(toFailure(error, filePath, "WriteFailed"));
		}
	}

	public async deleteNodeFile(
		filePath: string,
	): Promise<Result<void, FileSystemFailure>> {
		try {
			await withFsRetry(() => fsp.unlink(filePath));
			this.nodeStatsCache.delete(filePath);
			return ok(void 0);
		} catch (error: unknown) {
			return err(toFailure(error, filePath, "WriteFailed"));
		}
	}

	public async getNodeStats(
		filePath: string,
	): Promise<Result<import("node:fs").Stats, FileSystemFailure>> {
		const cached = this.nodeStatsCache.get(filePath);
		if (cached) return cached.value;

		try {
			const stats = await withFsRetry(() => fsp.stat(filePath));
			const res = ok(stats);
			this.nodeStatsCache.set(filePath, { value: res, timestamp: Date.now() });
			return res;
		} catch (error: unknown) {
			const code = isNodeErrnoException(error) ? error.code : undefined;
			switch (code) {
				case "ENOENT": {
					const res = err({
						kind: "NotFound",
						path: filePath,
					} as FileSystemFailure);
					this.nodeStatsCache.set(filePath, {
						value: res,
						timestamp: Date.now(),
					});
					return res;
				}
				case "EACCES":
				case "EPERM": {
					const res = err({
						kind: "PermissionDenied",
						path: filePath,
					} as FileSystemFailure);
					this.nodeStatsCache.set(filePath, {
						value: res,
						timestamp: Date.now(),
					});
					return res;
				}
				case "ENOTDIR": {
					const res = err({
						kind: "NotADirectory",
						path: filePath,
					} as FileSystemFailure);
					this.nodeStatsCache.set(filePath, {
						value: res,
						timestamp: Date.now(),
					});
					return res;
				}
				default: {
					const res = err({
						kind: "ReadFailed",
						path: filePath,
						cause: error,
					} as FileSystemFailure);
					this.nodeStatsCache.set(filePath, {
						value: res,
						timestamp: Date.now(),
					});
					return res;
				}
			}
		}
	}

	public async *iterateNodeDirectory(
		dirPath: string,
		opts?: {
			recursive?: boolean;
			signal?: AbortSignal;
			shouldEnterDir?: (fullPath: string, dirName: string) => boolean;
		},
	): AsyncIterable<
		Result<
			{ path: string; dirent: import("node:fs").Dirent },
			FileSystemFailure
		>
	> {
		const recursive = opts?.recursive ?? false;
		const signal = opts?.signal;
		const stack: string[] = [dirPath];
		let yielded = 0;

		while (stack.length > 0) {
			if (signal?.aborted) return;

			const current = stack.pop()!;
			let dir: import("node:fs").Dir | undefined;
			try {
				dir = await fsp.opendir(current);
				for await (const dirent of dir) {
					if (signal?.aborted) {
						await dir.close().catch(() => {});
						return;
					}
					const full = Pathing.joinSystemPath(current, dirent.name);
					yield ok({ path: full, dirent });

					if (
						recursive &&
						dirent.isDirectory() &&
						(!opts?.shouldEnterDir || opts.shouldEnterDir(full, dirent.name))
					) {
						stack.push(full);
					}

					if (++yielded % 500 === 0) await Promise.resolve(); // Yield
				}
			} catch (error) {
				const failure = toFailure(error, current, "ReadFailed");
				yield err(failure);
			} finally {
				await dir?.close().catch(() => {});
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/*                        PRIVATE IMPLEMENTATION                      */
	/* ------------------------------------------------------------------ */

	public async isPluginDirWritable(): Promise<boolean> {
		try {
			const probePath = this.joinPluginDataPath(".probe");
			await this.vault.adapter.write(probePath, "");
			await this.vault.adapter.remove(probePath);
			return true;
		} catch (_e) {
			return false;
		}
	}

	/**
	 * Write-and-delete probe helper. Writes an empty string to the given
	 * vault-relative path and immediately removes it. Returns true on success,
	 * false on failure. Deletion is best-effort and does not affect success.
	 */
	public async writeProbe(vaultPath: string): Promise<boolean> {
		const normalized = Pathing.toVaultPath(vaultPath);
		try {
			await this.vault.adapter.write(normalized, "");
		} catch {
			return false;
		}
		// Best-effort cleanup; ignore failures
		try {
			await this.vault.adapter.remove(normalized);
		} catch {}
		return true;
	}

	/**
	 * Moves a file within the vault, preferring an atomic rename and falling back to copy+delete.
	 * Uses retry logic for transient filesystem errors.
	 */
	public async moveVaultPath(
		src: string,
		dst: string,
	): Promise<Result<void, AppFailure>> {
		// Directly calls the robust, corrected private method.
		return this._atomicMove(src, dst);
	}

	/**
	 * Attempts an atomic rename only. Returns true on success, false if rename failed.
	 * Does NOT fall back to copy+delete. Caller controls any fallback behavior.
	 */
	public async tryRenameVaultPath(
		oldPath: string,
		newPath: string,
	): Promise<Result<boolean, AppFailure>> {
		const s = Pathing.toVaultPath(oldPath);
		const d = Pathing.toVaultPath(newPath);
		const ensured = await this.ensureParentDirectory(d);
		if (isErr(ensured)) return err(ensured.error);
		try {
			await renameWithRetry(this.vault.adapter, s, d, {
				maxAttempts: 6,
				baseDelayMs: 30,
			});
			return ok(true);
		} catch (_e) {
			return ok(false);
		}
	}

	/**
	 * Retrieves file stats (mtime) for a path within the vault using the adapter.
	 * Returns null if the adapter doesn't support `stat` or the file doesn't exist.
	 */
	public async statVaultPath(
		vaultPath: string,
	): Promise<{ mtime: number } | null> {
		const p = Pathing.toVaultPath(vaultPath);
		try {
			// This runtime check is essential. It guards against adapters that
			// don't fully implement the non-standard parts of the API.
			if (typeof this.adapter.stat === "function") {
				const st = await this.adapter.stat(p);
				if (st) {
					const mtime = Number(st.mtime ?? 0);
					return { mtime: Number.isNaN(mtime) ? 0 : mtime };
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Best-effort absolute base path of the current vault, or null if unavailable.
	 */
	public getVaultAbsoluteBasePath(): string | null {
		try {
			if (typeof this.adapter.getBasePath === "function") {
				return String(this.adapter.getBasePath());
			}
			// Some adapters expose getFullPath(rel)
			if (typeof this.adapter.getFullPath === "function") {
				// Any rel path will do; strip it back
				const probe = this.adapter.getFullPath(".");
				return typeof probe === "string"
					? String(probe).replace(/[/]+.?$/, "")
					: null;
			}
		} catch {
			// ignore
		}
		return null;
	}

	/**
	 * Recursively lists all file paths under a given vault root using the adapter.
	 * This is safe for use in the plugin data directory.
	 */
	public async walkVaultDirPaths(
		root: string,
		opts?: { recursive?: boolean; extensions?: string[] },
	): Promise<string[]> {
		const rec = opts?.recursive ?? true;
		const exts = (opts?.extensions ?? []).map((e) =>
			e.replace(/^\./, "").toLowerCase(),
		);
		const out: string[] = [];

		const visit = async (dir: string) => {
			const r = await this.listVaultDir(dir);
			if (isErr(r)) return; // swallow and skip this branch
			const { files, folders } = r.value;
			for (const f of files) {
				const include =
					exts.length === 0
						? true
						: (() => {
								const ext = f.split(".").pop()?.toLowerCase();
								return !!ext && exts.includes(ext);
							})();
				if (include) out.push(f); // f is already vault-relative full path
			}
			if (rec) {
				for (const sub of folders) {
					await visit(sub); // sub is already full vault-relative path
				}
			}
		};

		await visit(Pathing.toVaultPath(root));
		return out;
	}

	private async _atomicMove(
		src: string,
		dst: string,
	): Promise<Result<void, AppFailure>> {
		const s = Pathing.toVaultPath(src);
		const d = Pathing.toVaultPath(dst);

		const ensured = await this.ensureParentDirectory(d);
		if (isErr(ensured)) return ensured;

		return this.keyedQueue.run(`atomic:${d}`, async () => {
			try {
				const replaceSupported = await this.probeRenameReplaceSupport();
				if (replaceSupported) {
					await renameWithRetry(this.vault.adapter, s, d, {
						maxAttempts: 4,
						baseDelayMs: 30,
					});
					return ok(void 0);
				}
			} catch {
				// Fallback to copy+delete if atomic rename is not supported or fails
			}

			// Fallback: copy+delete
			const dataRes = await this.readVaultBinary(s);

			// 1. Check if the read operation failed.
			if (isErr(dataRes)) {
				// 2. If it failed, propagate the error result immediately.
				return dataRes;
			}

			// 3. Only if the read was successful, access `.value`.
			const writeRes = await this.writeVaultBinaryAtomic(d, dataRes.value);
			if (isErr(writeRes)) return writeRes;

			const rmRes = await this.removeVaultPath(s);
			if (isErr(rmRes)) return rmRes;

			return ok(void 0);
		});
	}

	private handleMkdirError(
		error: unknown,
		path: string,
	): Result<void, AppFailure> {
		const failure = toFailure(error, path, "WriteFailed");
		// EEXIST is a success condition for an "ensure" operation.
		if (failure.kind === "AlreadyExists") {
			return ok(void 0);
		}
		return err(failure);
	}
}
