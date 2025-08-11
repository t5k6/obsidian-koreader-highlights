import { promises as fsp } from "node:fs";
import path, { posix as posixPath } from "node:path";
import {
	Notice,
	normalizePath,
	type Plugin,
	TFile,
	TFolder,
	type Vault,
} from "obsidian";
import type { Cache } from "src/types";
import type { CacheManager } from "src/utils/cache/CacheManager";
import { KeyedQueue } from "src/utils/concurrency";
import { normalizeFileNamePiece } from "src/utils/formatUtils";

/* ------------------------------------------------------------------ */
/*                              TYPES                                 */
/* ------------------------------------------------------------------ */

export enum FileSystemErrorCode {
	NotFound = "ENOENT",
	AccessDenied = "EACCES",
	Permission = "EPERM",
	IsDirectory = "EISDIR",
	NotDirectory = "ENOTDIR",
	AlreadyExists = "EEXIST",
	Unknown = "UNKNOWN",
}

export class FileSystemError extends Error {
	constructor(
		public readonly operation: string,
		public readonly path: string,
		public readonly code: FileSystemErrorCode,
		message?: string,
	) {
		super(message || `${operation} failed on ${path}: ${code}`);
		this.name = "FileSystemError";
	}

	get isNotFound(): boolean {
		return this.code === FileSystemErrorCode.NotFound;
	}
	get isPermissionDenied(): boolean {
		return (
			this.code === FileSystemErrorCode.AccessDenied ||
			this.code === FileSystemErrorCode.Permission
		);
	}
}

interface CacheEntry<T> {
	value: T;
	timestamp: number;
}
interface FileCreationOptions {
	maxAttempts?: number;
	useTimestampFallback?: boolean;
	failOnFirstCollision?: boolean;
}

export interface FolderScanResult {
	files: TFile[];
	aborted: boolean;
}

export class FileSystemService {
	private readonly LOG_PREFIX = "KOReader Importer: FileSystemService:";
	private readonly folderExistsCache!: Cache<string, CacheEntry<boolean>>;
	private readonly nodeStatsCache!: Cache<
		string,
		CacheEntry<import("node:fs").Stats | null>
	>;
	private readonly CACHE_TTL = 5000;
	private readonly keyedQueue = new KeyedQueue();
	private readonly recentNotices = new Map<string, number>();
	private renameReplaceSupported: boolean | null = null;
	private loggedCapabilityOnce = false;
	private folderScanCache!: import("src/utils/cache/LruCache").LruCache<
		string,
		FolderScanResult
	>;

	constructor(
		private readonly vault: Vault,
		private readonly plugin: Plugin,
		private readonly cacheManager: CacheManager,
	) {
		this.folderExistsCache = this.cacheManager.createMap("fs.folderExists");
		this.nodeStatsCache = this.cacheManager.createMap("fs.nodeStats");
		this.folderScanCache = this.cacheManager.createLru("fs.folderScan", 200);
		this.registerVaultEvents();
	}

	/* ------------------------------------------------------------------ */
	/*                        STATIC HELPERS & UTILS                      */
	/* ------------------------------------------------------------------ */

	public static normalizeSystemPath(p: string | null | undefined): string {
		if (!p) return "";
		let s = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
		if (s.length > 1 && s.endsWith("/")) {
			s = s.slice(0, -1);
		}
		return s;
	}

	/**
	 * Converts a path to a canonical, vault-relative format.
	 * This is the single source of truth for path normalization.
	 */
	public static toVaultPath(rawPath: string | null | undefined): string {
		if (!rawPath) return "";
		const p = normalizePath(rawPath.trim());
		if (p === "/" || p === "." || p === "") return "";
		return p.replace(/^\/+/, "").replace(/\/+$/, "");
	}

	public static getVaultParent(vaultPath: string): string {
		const parent = posixPath.dirname(vaultPath);
		return parent === "." ? "" : parent;
	}

	private parseFolderScanKey(key: string): {
		rootPath: string;
		recursive: boolean;
	} {
		const [root, _exts, rflag] = key.split("|");
		return { rootPath: root ?? "", recursive: rflag === "R" };
	}

	public static isAncestor(ancestor: string, child: string): boolean {
		if (ancestor === "") return true; // vault root is ancestor of everything
		if (ancestor === child) return true;
		return child.startsWith(ancestor + "/");
	}

	/* ------------------------------------------------------------------ */
	/*                     SCANNING / WALKING FOLDERS                      */
	/* ------------------------------------------------------------------ */

	public async getFilesInFolder(
		folderVaultPathOrFolder: string | TFolder,
		options?: {
			extensions?: string[]; // defaults to ['md']
			recursive?: boolean; // defaults to true
			signal?: AbortSignal;
		},
	): Promise<FolderScanResult> {
		const { files, aborted } = await this.walkFolder(folderVaultPathOrFolder, {
			extensions: options?.extensions ?? ["md"],
			recursive: options?.recursive ?? true,
			signal: options?.signal,
		});
		return { files, aborted };
	}

	public async walkFolder(
		folderVaultPathOrFolder: string | TFolder,
		options?: {
			extensions?: string[];
			recursive?: boolean;
			signal?: AbortSignal;
		},
	): Promise<FolderScanResult> {
		const extensions = (options?.extensions ?? ["md"]).map((e) =>
			e.replace(/^\./, "").toLowerCase(),
		);
		const recursive = options?.recursive ?? true;
		const signal = options?.signal;

		const folderPath =
			typeof folderVaultPathOrFolder === "string"
				? FileSystemService.toVaultPath(folderVaultPathOrFolder)
				: folderVaultPathOrFolder.path;

		const root =
			typeof folderVaultPathOrFolder === "string"
				? this.vault.getAbstractFileByPath(folderPath)
				: folderVaultPathOrFolder;

		if (!(root instanceof TFolder)) {
			return { files: [], aborted: false };
		}

		const cacheKey = `${root.path}|${extensions.join(",")}|${recursive ? "R" : "NR"}`;
		const cached = this.folderScanCache.get(cacheKey);
		if (cached) return cached;

		const out: TFile[] = [];
		let aborted = false;

		const walk = (entry: any): void => {
			if (signal?.aborted) {
				aborted = true;
				return;
			}
			if (entry instanceof TFile) {
				const ext = entry.extension?.toLowerCase();
				if (ext && extensions.includes(ext)) out.push(entry);
				return;
			}
			const children = (entry as any)?.children as any[] | undefined;
			if (!children) return;
			for (const child of children) {
				if (signal?.aborted) {
					aborted = true;
					return;
				}
				if (child instanceof TFile) {
					const ext = child.extension?.toLowerCase();
					if (ext && extensions.includes(ext)) out.push(child);
				} else if (recursive) {
					walk(child);
				}
			}
		};
		walk(root);

		const result: FolderScanResult = { files: out, aborted };
		if (!aborted) this.folderScanCache.set(cacheKey, result);
		return result;
	}

	private registerVaultEvents(): void {
		// Invalidate scan cache when vault changes that can affect folder contents occur.
		this.plugin.registerEvent(
			this.vault.on("create", (file) => this.invalidateCacheFor(file.path)),
		);
		this.plugin.registerEvent(
			this.vault.on("delete", (file) => this.invalidateCacheFor(file.path)),
		);
		this.plugin.registerEvent(
			this.vault.on("rename", (file, oldPath) => {
				// Invalidate both old and new locations
				this.invalidateCacheFor(oldPath);
				this.invalidateCacheFor(file.path);
			}),
		);
	}

	private invalidateCacheFor(vaultPath: string): void {
		if (!this.folderScanCache) return;

		const changed = FileSystemService.toVaultPath(vaultPath);
		const immediateParent = FileSystemService.getVaultParent(changed);

		this.folderScanCache.deleteWhere((rawKey) => {
			const { rootPath: rawRoot, recursive } = this.parseFolderScanKey(
				String(rawKey),
			);
			const rootPath = FileSystemService.toVaultPath(rawRoot);

			const rootIsAncestorOfChanged = FileSystemService.isAncestor(
				rootPath,
				changed,
			);
			const rootUnderChangedSubtree =
				changed !== "" && rootPath.startsWith(changed + "/");

			if (recursive) {
				// Recursive scans are affected by any change under their root, and by subtree moves.
				return rootIsAncestorOfChanged || rootUnderChangedSubtree;
			} else {
				// Non-recursive scans only list direct children.
				// Invalidate if:
				// - the changed item's parent is the scan root (direct child added/removed/renamed), or
				// - the scan root itself changed (folder rename/delete), or
				// - the scan root is inside a moved/deleted subtree.
				return (
					rootPath === immediateParent ||
					rootPath === changed ||
					rootUnderChangedSubtree
				);
			}
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
	public getPluginDataDir(): string {
		return normalizePath(
			`${this.vault.configDir}/plugins/${this.plugin.manifest.id}`,
		);
	}

	/**
	 * Joins segments inside the plugin data dir and returns a vault-relative path.
	 */
	public joinPluginDataPath(...segments: string[]): string {
		const rel = path.join(this.getPluginDataDir(), ...segments);
		return FileSystemService.toVaultPath(rel);
	}

	private async probeRenameReplaceSupport(): Promise<boolean> {
		if (this.renameReplaceSupported !== null)
			return this.renameReplaceSupported;

		const dir = this.getPluginDataDir();
		const a = `${dir}/.__probe_a__${Date.now()}`;
		const b = `${dir}/.__probe_b__${Date.now()}`;
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
			try {
				await this.vault.adapter.remove(a);
			} catch {}
			try {
				await this.vault.adapter.remove(b);
			} catch {}
		}
		if (this.renameReplaceSupported === false && !this.loggedCapabilityOnce) {
			console.info(
				`${this.LOG_PREFIX} Adapter does not support rename-over-existing; using fallback swap for atomic writes.`,
			);
			this.loggedCapabilityOnce = true;
		}
		return this.renameReplaceSupported!;
	}

	/**
	 * Read binary file via the vault adapter using a vault-relative path.
	 */
	public async readVaultBinary(vaultPath: string): Promise<ArrayBuffer> {
		const normalizedPath = FileSystemService.toVaultPath(vaultPath);
		return this.vault.adapter.readBinary(normalizedPath);
	}

	/**
	 * Write binary file via the vault adapter using a vault-relative path.
	 * Ensures parent directory exists using adapter/vault APIs.
	 */
	public async writeVaultBinary(
		vaultPath: string,
		data: ArrayBuffer,
	): Promise<void> {
		const normalizedPath = FileSystemService.toVaultPath(vaultPath);
		await this.ensureParentDirectory(normalizedPath);
		return this.vault.adapter.writeBinary(normalizedPath, data);
	}

	/**
	 * Atomically write a binary file in the vault by writing to a temporary file
	 * and then renaming it over the target. Falls back to remove-then-rename
	 * when the adapter does not support rename-over-existing.
	 */
	public async writeVaultBinaryAtomic(
		vaultPath: string,
		data: ArrayBuffer,
	): Promise<void> {
		const dst = FileSystemService.toVaultPath(vaultPath);
		await this.ensureParentDirectory(dst);

		// Serialize writes to the same destination path
		await this.keyedQueue.run(`atomic:${dst}`, async () => {
			const tmp = `${dst}.__tmp__${Date.now()}-${Math.random()
				.toString(36)
				.slice(2)}`;
			await this.vault.adapter.writeBinary(tmp, data);

			const replaceSupported = await this.probeRenameReplaceSupport();
			if (replaceSupported) {
				// Try direct replace with small retries (transient locks)
				const delays = [10, 25, 50];
				for (let i = 0; i <= delays.length; i++) {
					try {
						await this.vault.adapter.rename(tmp, dst);
						return; // success
					} catch (e) {
						if (i === delays.length) {
							// degrade capability: some adapters claim support but fail; fall back
							console.info(
								`${this.LOG_PREFIX} rename-over-existing failed; falling back to backup-swap for ${dst}.`,
							);
							break;
						}
						await new Promise((r) => setTimeout(r, delays[i]));
					}
				}
			}

			// Fallback: backup-swap with rollback
			await this.replaceViaBackupSwap(dst, tmp);
		});
	}

	private async replaceViaBackupSwap(dst: string, tmp: string): Promise<void> {
		const bak = `${dst}.__bak__`;
		// Clean stale artifacts best-effort
		try {
			await this.vault.adapter.remove(bak);
		} catch {}
		// If destination exists, rename it to backup with retries
		const exists = await this.vault.adapter.exists(dst);
		const delays = [10, 25, 50, 80];
		if (exists) {
			for (let i = 0; i <= delays.length; i++) {
				try {
					await this.vault.adapter.rename(dst, bak);
					break;
				} catch (e) {
					if (i === delays.length) {
						// As a last resort, try remove (may briefly drop the file)
						try {
							await this.vault.adapter.remove(dst);
						} catch {}
						break;
					}
					await new Promise((r) => setTimeout(r, delays[i]));
				}
			}
		}

		// Now place tmp as dst (with retries)
		try {
			for (let i = 0; i <= delays.length; i++) {
				try {
					await this.vault.adapter.rename(tmp, dst);
					// success: cleanup backup
					try {
						await this.vault.adapter.remove(bak);
					} catch {}
					return;
				} catch (e) {
					if (i === delays.length) {
						// rollback if possible
						if (await this.vault.adapter.exists(bak)) {
							try {
								await this.vault.adapter.rename(bak, dst);
							} catch (restoreErr) {
								console.error(
									`${this.LOG_PREFIX} CRITICAL: failed to restore backup for ${dst}`,
									restoreErr,
								);
							}
						}
						throw e;
					}
					await new Promise((r) => setTimeout(r, delays[i]));
				}
			}
		} finally {
			// Ensure temp is removed if still around
			try {
				await this.vault.adapter.remove(tmp);
			} catch {}
		}
	}

	/**
	 * Write UTF-8 text atomically using the vault adapter. Ensures parent folder exists.
	 */
	public async writeVaultTextAtomic(
		vaultPath: string,
		content: string,
	): Promise<void> {
		const normalizedPath = FileSystemService.toVaultPath(vaultPath);
		await this.ensureParentDirectory(normalizedPath);
		const buffer = new TextEncoder().encode(content).buffer;
		await this.writeVaultBinaryAtomic(normalizedPath, buffer);
	}

	/**
	 * Read UTF-8 text using the vault adapter.
	 */
	public async readVaultText(vaultPath: string): Promise<string> {
		const buffer = await this.readVaultBinary(vaultPath);
		return new TextDecoder().decode(buffer);
	}

	/* ------------------------------------------------------------------ */
	/*                         AUTO-ROUTING HELPERS                        */
	/* ------------------------------------------------------------------ */

	/**
	 * Read binary content from either an absolute system path (Node fs)
	 * or a vault-relative path (Vault adapter), based on the input path.
	 */
	async readBinaryAuto(filePath: string): Promise<Uint8Array> {
		if (path.isAbsolute(filePath)) {
			// Node returns a Buffer (subclass of Uint8Array) with correct length
			return (await this.readNodeFile(filePath, true)) as Uint8Array;
		} else {
			// Ensure we create a view with the exact byteLength
			const ab = await this.readVaultBinary(filePath);
			return new Uint8Array(ab);
		}
	}

	/**
	 * Write binary content to either an absolute system path (Node fs)
	 * or a vault-relative path (Vault adapter), based on the input path.
	 */
	async writeBinaryAuto(filePath: string, data: Uint8Array): Promise<void> {
		if (path.isAbsolute(filePath)) {
			await this.writeNodeFile(filePath, data);
		} else {
			// Ensure we pass a true ArrayBuffer (not SharedArrayBuffer) to the adapter
			// and only the valid region of the view. Creating a sliced copy guarantees ArrayBuffer.
			const arrayBuffer: ArrayBuffer = data.slice().buffer;
			await this.writeVaultBinary(filePath, arrayBuffer);
		}
	}

	/* ------------------------------------------------------------------ */
	/*                         VAULT OPERATIONS                           */
	/* ------------------------------------------------------------------ */

	public async writeVaultFile(
		vaultPath: string,
		content: string,
	): Promise<TFile> {
		const normalizedPath = FileSystemService.toVaultPath(vaultPath);
		if (!normalizedPath) {
			const msg = "A valid vault path must be provided.";
			console.error(`${this.LOG_PREFIX} ${msg}`);
			throw new Error(msg);
		}

		await this.ensureParentDirectory(normalizedPath);

		const existing = this.vault.getAbstractFileByPath(normalizedPath);
		if (existing instanceof TFolder) {
			const msg = `Path exists but is a folder: ${normalizedPath}`;
			console.error(`${this.LOG_PREFIX} ${msg}`);
			throw new Error(msg);
		}

		if (existing instanceof TFile) {
			await this.vault.modify(existing, content);
			return existing;
		}
		try {
			return await this.vault.create(normalizedPath, content);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (
				code === "EEXIST" ||
				(error instanceof Error && /already exists/i.test(error.message))
			) {
				// Another process created it between our check and create; modify instead.
				const nowExisting = this.vault.getAbstractFileByPath(normalizedPath);
				if (nowExisting instanceof TFile) {
					await this.vault.modify(nowExisting, content);
					return nowExisting;
				}
			}
			throw error;
		}
	}

	public async ensurePluginDataDirExists(): Promise<void> {
		const dir = this.getPluginDataDir(); // ".obsidian/plugins/<id>"
		try {
			await this.ensureAdapterFolder(dir);
		} catch (error) {
			console.error(
				`${this.LOG_PREFIX} Failed to ensure plugin data directory: ${dir}`,
				error,
			);
			throw error;
		}
	}

	public async vaultExists(vaultPath: string): Promise<boolean> {
		return this.vault.adapter.exists(FileSystemService.toVaultPath(vaultPath));
	}

	public async ensureVaultFolder(folderPath: string): Promise<void> {
		const normalized = FileSystemService.toVaultPath(folderPath);
		if (!normalized) return;

		// If the path is inside the hidden config dir, we must use the adapter.
		if (normalized.startsWith(this.vault.configDir)) {
			await this.ensureAdapterFolder(normalized);
			return;
		}

		await this.keyedQueue.run(`folder:${normalized}`, async () => {
			const cached = this.folderExistsCache.get(normalized);
			if (cached && this.isCacheValid(cached)) return;

			try {
				const abstract = this.vault.getAbstractFileByPath(normalized);
				if (abstract instanceof TFolder) {
					this.folderExistsCache.set(normalized, {
						value: true,
						timestamp: Date.now(),
					});
					return;
				}
				if (abstract) {
					throw new FileSystemError(
						"ensureFolder",
						normalized,
						FileSystemErrorCode.NotDirectory,
						"Path exists but is a file",
					);
				}
				await this.vault.createFolder(normalized);
				this.folderExistsCache.set(normalized, {
					value: true,
					timestamp: Date.now(),
				});
			} catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code;
				if (
					code === "EEXIST" ||
					(error instanceof Error &&
						(/already exists/i.test(error.message) ||
							/Folder already exists/i.test(error.message)))
				) {
					console.log(
						`${this.LOG_PREFIX} ensureVaultFolder: Handled race condition for '${normalized}'.`,
					);
					this.folderExistsCache.set(normalized, {
						value: true,
						timestamp: Date.now(),
					});
					return;
				}
				// If the error is already a FileSystemError we produced above,
				// rethrow it directly to avoid double-wrapping and clearer stacks.
				if (error instanceof FileSystemError) throw error;
				this.handleError("ensureFolder", normalized, error, true);
			}
		});
	}

	public async ensureParentDirectory(filePath: string): Promise<void> {
		const parentDir = FileSystemService.getVaultParent(filePath);
		if (parentDir) await this.ensureVaultFolder(parentDir);
	}

	/**
	 * @deprecated Backwards-compatible helper used in tests and some code paths.
	 * Prefer createVaultFileUnique().
	 *
	 * Behavior:
	 * - If failOnFirstCollision=true, throws AlreadyExists when the base name exists.
	 * - Otherwise tries numbered suffixes " (n)" up to maxAttempts.
	 * - If exhausted and useTimestampFallback=true, creates a "-<ts>" filename.
	 * - Else throws AlreadyExists.
	 */
	public async createVaultFileSafely(
		baseDir: string,
		filenameStem: string,
		content: string,
		options?: {
			ext?: string;
			failOnFirstCollision?: boolean;
			maxAttempts?: number;
			useTimestampFallback?: boolean;
		},
	): Promise<TFile> {
		const ext = (options?.ext ?? "md").replace(/^\./, "");
		const dir = FileSystemService.toVaultPath(baseDir);
		const stem = normalizeFileNamePiece(filenameStem);
		const maxAttempts = Math.max(1, options?.maxAttempts ?? 10);
		const useTs = !!options?.useTimestampFallback;

		await this.ensureVaultFolder(dir);

		const basePath = normalizePath(`${dir}/${stem}.${ext}`);
		if (options?.failOnFirstCollision) {
			if (await this.vaultExists(basePath)) {
				throw new FileSystemError(
					"createFile",
					basePath,
					FileSystemErrorCode.AlreadyExists,
					"File already exists",
				);
			}
			return this.vault.create(basePath, content);
		}

		for (let i = 0; i < maxAttempts; i++) {
			const suffix = i === 0 ? "" : ` (${i})`;
			const candidate = normalizePath(`${dir}/${stem}${suffix}.${ext}`);
			// eslint-disable-next-line no-await-in-loop
			const exists = await this.vaultExists(candidate);
			if (!exists) {
				// eslint-disable-next-line no-await-in-loop
				return this.vault.create(candidate, content);
			}
		}

		if (useTs) {
			const ts = Date.now().toString(36);
			const candidate = normalizePath(`${dir}/${stem}-${ts}.${ext}`);
			return this.vault.create(candidate, content);
		}

		throw new FileSystemError(
			"createFile",
			basePath,
			FileSystemErrorCode.AlreadyExists,
			"All candidate filenames already exist",
		);
	}

	public async createVaultFileUnique(
		baseDir: string,
		desiredStem: string,
		content: string,
		ext: string = "md",
	): Promise<TFile> {
		const normalizedDir = FileSystemService.toVaultPath(baseDir);
		const sanitizedStem = normalizeFileNamePiece(desiredStem);

		return this.keyedQueue.run(
			`file:${normalizedDir}/${sanitizedStem}`,
			async () => {
				await this.ensureVaultFolder(normalizedDir);
				const finalStem = await this.generateUniqueStem(
					normalizedDir,
					sanitizedStem,
					ext,
				);
				const finalPath = normalizePath(`${normalizedDir}/${finalStem}.${ext}`);
				// Within keyedQueue, check-then-create is effectively atomic for a given stem.
				return this.vault.create(finalPath, content);
			},
		);
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
		const dir = FileSystemService.toVaultPath(baseDir);
		return this.generateUniqueStem(
			dir,
			normalizeFileNamePiece(desiredStem),
			"md",
		);
	}

	/**
	 * Core unique-stem generator. Private to enforce atomic creation pattern via keyedQueue.
	 */
	private async generateUniqueStem(
		dir: string,
		stem: string,
		ext: string,
		maxAttempts: number = 1000,
	): Promise<string> {
		for (let i = 0; i < maxAttempts; i++) {
			const suffix = i === 0 ? "" : ` (${i})`;
			const candidateStem = `${stem}${suffix}`;
			const candidatePath = normalizePath(`${dir}/${candidateStem}.${ext}`);
			// eslint-disable-next-line no-await-in-loop
			if (!(await this.vaultExists(candidatePath))) {
				return candidateStem;
			}
		}
		// Fallback to timestamp if all attempts fail
		const ts = Date.now().toString(36);
		return `${stem}-${ts}`;
	}

	/* ------------------------------------------------------------------ */
	/*                         NODE.JS OPERATIONS                         */
	/* ------------------------------------------------------------------ */

	public async nodeFileExists(filePath: string): Promise<boolean> {
		try {
			await fsp.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	async readNodeFile(filePath: string, binary: true): Promise<Uint8Array>;
	async readNodeFile(filePath: string, binary?: false): Promise<string>;
	async readNodeFile(
		filePath: string,
		binary: boolean = false,
	): Promise<string | Uint8Array> {
		try {
			return await (binary
				? fsp.readFile(filePath)
				: fsp.readFile(filePath, "utf-8"));
		} catch (error) {
			this.handleError("readNodeFile", filePath, error, true);
			throw new Error("unreachable"); // satisfy TS; handleError throws
		}
	}

	async writeNodeFile(
		filePath: string,
		data: string | Uint8Array,
	): Promise<void> {
		try {
			await fsp.mkdir(path.dirname(filePath), { recursive: true });
			await fsp.writeFile(filePath, data);
			this.nodeStatsCache.delete(filePath);
		} catch (error) {
			this.handleError("writeNodeFile", filePath, error, true);
		}
	}

	async deleteNodeFile(filePath: string): Promise<void> {
		try {
			await fsp.unlink(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				console.log(
					`${this.LOG_PREFIX} deleteNodeFile: File not found, likely already deleted: ${filePath}`,
				);
				return;
			}
			this.handleError("deleteNodeFile", filePath, error, true);
		}
	}

	async getNodeStats(
		filePath: string,
	): Promise<import("node:fs").Stats | null> {
		const cached = this.nodeStatsCache.get(filePath);
		if (cached && this.isCacheValid(cached)) return cached.value;

		try {
			const stats = await fsp.stat(filePath);
			this.nodeStatsCache.set(filePath, {
				value: stats,
				timestamp: Date.now(),
			});
			return stats;
		} catch (error: any) {
			if (error.code === "ENOENT") {
				this.nodeStatsCache.set(filePath, {
					value: null,
					timestamp: Date.now(),
				});
				return null;
			}
			console.error(
				`${this.LOG_PREFIX} Failed to stat path: ${filePath}`,
				error,
			);
			throw error;
		}
	}

	async *iterateNodeDirectory(
		dirPath: string,
	): AsyncIterable<import("node:fs").Dirent> {
		let dirHandle: import("node:fs").Dir | undefined;
		try {
			dirHandle = await fsp.opendir(dirPath);
			for await (const dirent of dirHandle) yield dirent;
		} catch (error) {
			const fsError = this.asFileSystemError("readDirectory", dirPath, error);
			if (fsError.isPermissionDenied) {
				console.log(
					`${this.LOG_PREFIX} Permission denied while scanning directory (skipping): ${dirPath}`,
				);
			} else if (!fsError.isNotFound) {
				console.warn(
					`${this.LOG_PREFIX} Could not fully read directory, skipping rest of its contents: ${dirPath}`,
					error,
				);
			}
		} finally {
			if (dirHandle) {
				try {
					await dirHandle.close();
				} catch {
					// ignore close errors
				}
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/*                        PRIVATE IMPLEMENTATION                      */
	/* ------------------------------------------------------------------ */

	private isCacheValid<T>(entry: CacheEntry<T>): boolean {
		return Date.now() - entry.timestamp < this.CACHE_TTL;
	}

	private showNoticeThrottled(message: string): void {
		const COOL = 5000;
		const now = Date.now();
		const last = this.recentNotices.get(message) ?? 0;
		if (now - last > COOL) {
			new Notice(message, 7000);
			this.recentNotices.set(message, now);
		}
		if (this.recentNotices.size > 20) {
			for (const [k, t] of this.recentNotices) {
				if (now - t > COOL * 2) this.recentNotices.delete(k);
			}
		}
	}

	private mapCode(code?: string): FileSystemErrorCode {
		switch (code) {
			case "ENOENT":
				return FileSystemErrorCode.NotFound;
			case "EACCES":
				return FileSystemErrorCode.AccessDenied;
			case "EPERM":
				return FileSystemErrorCode.Permission;
			case "EISDIR":
				return FileSystemErrorCode.IsDirectory;
			case "ENOTDIR":
				return FileSystemErrorCode.NotDirectory;
			case "EEXIST":
				return FileSystemErrorCode.AlreadyExists;
			default:
				return FileSystemErrorCode.Unknown;
		}
	}

	private asFileSystemError(
		operation: string,
		p: string,
		error: unknown,
	): FileSystemError {
		const nodeError = error as NodeJS.ErrnoException;
		const code = this.mapCode(nodeError?.code);
		return new FileSystemError(operation, p, code, nodeError?.message);
	}

	private handleError(
		operation: string,
		p: string,
		error: unknown,
		shouldThrow: boolean,
	): void {
		// Avoid double-wrapping when a FileSystemError is already provided.
		const fsError =
			error instanceof FileSystemError
				? error
				: this.asFileSystemError(operation, p, error);
		const userMessage = this.userMsg(fsError.code, p);
		console.error(
			`${this.LOG_PREFIX} ${fsError.message}`,
			(error as Error)?.stack,
		);

		if (
			fsError.isPermissionDenied ||
			fsError.code === FileSystemErrorCode.NotDirectory ||
			fsError.code === FileSystemErrorCode.AlreadyExists
		) {
			this.showNoticeThrottled(userMessage);
		}
		if (shouldThrow) throw fsError;
	}

	private userMsg(code: FileSystemErrorCode, p: string): string {
		switch (code) {
			case FileSystemErrorCode.NotFound:
				return `File or folder not found: ${p}`;
			case FileSystemErrorCode.AccessDenied:
			case FileSystemErrorCode.Permission:
				return `Permission denied: ${p}`;
			case FileSystemErrorCode.IsDirectory:
				return `Expected a file, but found a directory: ${p}`;
			case FileSystemErrorCode.NotDirectory:
				return `Expected a directory, but found a file: ${p}`;
			case FileSystemErrorCode.AlreadyExists:
				return `File already exists: ${p}`;
			default:
				return "File operation failed. Check console for details.";
		}
	}

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
		const normalized = FileSystemService.toVaultPath(vaultPath);
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

	/* Recursively mkdir using the adapter so it also works for the hidden
	 * .obsidian folder.  The vault API cannot do that.                     */
	private async ensureAdapterFolder(vaultRelPath: string): Promise<void> {
		const normalized = FileSystemService.toVaultPath(vaultRelPath);
		if (!normalized) return;

		// Use a lock to prevent race conditions on directory creation.
		// The lock key is for the specific folder path to serialize its creation.
		await this.keyedQueue.run(`folder-adapter:${normalized}`, async () => {
			// Check existence *inside* the lock to ensure atomicity.
			if (await this.vault.adapter.exists(normalized)) {
				return;
			}

			const segments = normalized.split("/");
			let current = "";
			for (const seg of segments) {
				current = current ? `${current}/${seg}` : seg;
				try {
					// Check existence of each segment before creating.
					// eslint-disable-next-line no-await-in-loop
					if (!(await this.vault.adapter.exists(current))) {
						// eslint-disable-next-line no-await-in-loop
						await this.vault.adapter.mkdir(current);
					}
				} catch (e: any) {
					// Handle the case where another process creates the dir between our check and mkdir.
					if (e instanceof Error && /already exists/i.test(e.message)) {
						continue; // This is fine, we can continue to the next segment.
					}
					// If it's another error, re-throw it.
					throw e;
				}
			}
		});
	}
}
