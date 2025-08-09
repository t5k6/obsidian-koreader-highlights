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
		const normalizedPath = FileSystemService.toVaultPath(vaultPath);
		const parentDir = FileSystemService.getVaultParent(normalizedPath);
		await this.ensureVaultFolder(parentDir);

		const tempPath = `${normalizedPath}.__tmp__${Date.now()}`;
		await this.vault.adapter.writeBinary(tempPath, data);

		try {
			await this.vault.adapter.rename(tempPath, normalizedPath);
		} catch (renameError) {
			console.warn(
				`Atomic rename failed for ${normalizedPath}, falling back to remove-then-rename.`,
			);
			try {
				await this.vault.adapter.remove(normalizedPath);
			} catch (removeError) {
				if (!(removeError as any)?.message?.includes("no such file")) {
					console.error(
						`Failed to remove target for atomic write fallback: ${normalizedPath}`,
						removeError,
					);
				}
			}
			await this.vault.adapter.rename(tempPath, normalizedPath);
		}
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

	public async createVaultFileSafely(
		baseDir: string,
		filenameStem: string,
		content: string,
		options: FileCreationOptions = {},
	): Promise<TFile> {
		const normalizedDir = FileSystemService.toVaultPath(baseDir);
		const lockKey = `${normalizedDir}/${filenameStem}`;
		return this.keyedQueue.run(`file:${lockKey}`, async () => {
			await this.ensureVaultFolder(normalizedDir);
			const { maxAttempts = 1000, useTimestampFallback = true } = options;

			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				const suffix = attempt === 0 ? "" : ` (${attempt})`;
				const candidate = normalizePath(
					`${normalizedDir}/${filenameStem}${suffix}.md`,
				);
				if (!(await this.vaultExists(candidate))) {
					try {
						return await this.vault.create(candidate, content);
					} catch (error) {
						const code = (error as NodeJS.ErrnoException)?.code;
						// Handle races robustly across different adapters/messages
						if (
							code === "EEXIST" ||
							(error instanceof Error && /already exists/i.test(error.message))
						) {
							continue;
						}
						throw error;
					}
				}
			}

			if (useTimestampFallback) {
				// Guard against extremely rare collisions on timestamp by checking and retrying once.
				for (let i = 0; i < 2; i++) {
					const ts = `${Date.now().toString(36)}${i ? `-${i}` : ""}`;
					const fallback = normalizePath(
						`${normalizedDir}/${filenameStem}-${ts}.md`,
					);
					if (!(await this.vaultExists(fallback))) {
						try {
							return await this.vault.create(fallback, content);
						} catch (error) {
							const code = (error as NodeJS.ErrnoException)?.code;
							if (
								code === "EEXIST" ||
								(error instanceof Error &&
									/already exists/i.test(error.message))
							) {
								continue; // try the next fallback
							}
							throw error;
						}
					}
				}
			}

			throw new FileSystemError(
				"createFile",
				`${normalizedDir}/${filenameStem}`,
				FileSystemErrorCode.AlreadyExists,
				`Could not create unique filename after ${maxAttempts} attempts`,
			);
		});
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
		} catch (e) {
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
