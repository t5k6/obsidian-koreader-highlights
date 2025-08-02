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

class NoticeManager {
	private recentNotices = new Map<string, number>();
	private readonly NOTICE_COOLDOWN_MS = 5000;

	public show(message: string): void {
		const now = Date.now();
		const lastShown = this.recentNotices.get(message) ?? 0;
		if (now - lastShown > this.NOTICE_COOLDOWN_MS) {
			new Notice(message, 7000);
			this.recentNotices.set(message, now);
		}
		// Simple cache cleanup
		if (this.recentNotices.size > 20) {
			for (const [key, timestamp] of this.recentNotices.entries()) {
				if (now - timestamp > this.NOTICE_COOLDOWN_MS * 2) {
					this.recentNotices.delete(key);
				}
			}
		}
	}
}

/* ------------------------------------------------------------------ */
/*                         FILE SYSTEM SERVICE                       */
/* ------------------------------------------------------------------ */

export class FileSystemService {
	private readonly LOG_PREFIX = "KOReader Importer: FileSystemService:";
	private readonly folderExistsCache!: Cache<string, CacheEntry<boolean>>;
	private readonly nodeStatsCache!: Cache<
		string,
		CacheEntry<import("node:fs").Stats | null>
	>;
	private readonly CACHE_TTL = 5000; // 5 seconds
	private readonly fileCreationLocks = new Map<string, Promise<void>>();
	private readonly folderCreationLocks = new Map<string, Promise<void>>();
	private readonly noticeManager = new NoticeManager();

	constructor(
		private readonly vault: Vault,
		private readonly plugin: Plugin,
		private readonly cacheManager: CacheManager,
	) {
		this.folderExistsCache = this.cacheManager.createMap<
			string,
			CacheEntry<boolean>
		>("fs.folderExists");
		this.nodeStatsCache = this.cacheManager.createMap<
			string,
			CacheEntry<import("node:fs").Stats | null>
		>("fs.nodeStats");
	}

	/* ------------------------------------------------------------------ */
	/*                        STATIC HELPERS & UTILS                      */
	/* ------------------------------------------------------------------ */

	/**
	 * Normalizes an absolute system path to use forward slashes, which is safer
	 * for internal consistency and cross-platform compatibility.
	 * @param absolutePath The platform-specific absolute path (e.g., "C:\\Users\\User").
	 * @returns A path string using only forward slashes (e.g., "C:/Users/User").
	 */
	public static normalizeSystemPath(
		absolutePath: string | null | undefined,
	): string {
		if (!absolutePath) {
			return "";
		}
		return absolutePath.replace(/\\/g, "/");
	}

	/**
	 * Converts a path to a canonical, vault-relative format.
	 * This is the single source of truth for path normalization.
	 *
	 * - Uses forward slashes.
	 * - Removes leading and trailing slashes.
	 * - Handles null/undefined/empty inputs gracefully.
	 *
	 * @example
	 * toVaultPath("/folder/file.md") // -> "folder/file.md"
	 * toVaultPath("folder/path/")     // -> "folder/path"
	 * toVaultPath("")                 // -> ""
	 * toVaultPath("/")                // -> "" (vault root)
	 *
	 * @param rawPath The raw path string to normalize.
	 * @returns A clean, relative path for use within the vault.
	 */
	public static toVaultPath(rawPath: string | null | undefined): string {
		if (!rawPath) {
			return "";
		}

		// Use Obsidian's normalizePath to handle backslashes and initial trim
		const path = normalizePath(rawPath.trim());

		// An empty path or a single slash represents the vault root.
		if (path === "/" || path === ".") {
			return "";
		}

		// Remove any leading or trailing slashes
		return path.replace(/^\/+/, "").replace(/\/+$/, "");
	}

	public static getVaultParent(vaultPath: string): string {
		return posixPath.dirname(vaultPath);
	}

	/* ------------------------------------------------------------------ */
	/*                         VAULT OPERATIONS                          */
	/* ------------------------------------------------------------------ */

	public async writeVaultFile(
		vaultPath: string,
		content: string,
	): Promise<TFile> {
		const normalizedPath = FileSystemService.toVaultPath(vaultPath);
		if (!normalizedPath) {
			const message = "A valid vault path must be provided.";
			console.error(`${this.LOG_PREFIX} ${message}`);
			throw new Error(message);
		}

		await this.ensureParentDirectory(normalizedPath);

		const existingFile = this.vault.getAbstractFileByPath(normalizedPath);

		if (existingFile instanceof TFolder) {
			const message = `Path exists but is a folder: ${normalizedPath}`;
			console.error(`${this.LOG_PREFIX} ${message}`);
			throw new Error(message);
		}

		if (existingFile instanceof TFile) {
			// File exists, modify it.
			await this.vault.modify(existingFile, content);
			return existingFile; // Return the original TFile object
		} else {
			// File does not exist, create it.
			return this.vault.create(normalizedPath, content);
		}
	}

	public async ensurePluginDataDirExists(): Promise<void> {
		const pluginDataPath = path.join(
			this.vault.configDir,
			"plugins",
			this.plugin.manifest.id,
		);
		try {
			await fsp.mkdir(pluginDataPath, { recursive: true });
		} catch (error) {
			console.error(
				`${this.LOG_PREFIX} Failed to create plugin data directory at: ${pluginDataPath}`,
				error,
			);
			throw new Error(
				`Could not create plugin data directory. The plugin cannot continue.`,
			);
		}
	}

	async vaultExists(path: string): Promise<boolean> {
		const normalized = FileSystemService.toVaultPath(path);
		return this.vault.adapter.exists(normalized);
	}

	public async vaultFileExists(vaultPath: string): Promise<boolean> {
		return this.vault.adapter.exists(normalizePath(vaultPath));
	}

	async ensureVaultFolder(folderPath: string): Promise<void> {
		const normalized = FileSystemService.toVaultPath(folderPath);

		return this.withFolderCreationLock(normalized, async () => {
			if (!normalized) return; // Don't try to create the root folder

			const cached = this.folderExistsCache.get(normalized);
			if (cached && this.isCacheValid(cached)) {
				return;
			}

			try {
				const abstractFile = this.vault.getAbstractFileByPath(normalized);
				if (abstractFile instanceof TFolder) {
					this.folderExistsCache.set(normalized, {
						value: true,
						timestamp: Date.now(),
					});
					return;
				}
				if (abstractFile) {
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
				if (
					error instanceof Error &&
					error.message.includes("Folder already exists")
				) {
					console.log(
						`${this.LOG_PREFIX} ensureVaultFolder: Handled race condition for creating '${normalized}'.`,
					);
					this.folderExistsCache.set(normalized, {
						value: true,
						timestamp: Date.now(),
					});
					return;
				}
				this.handleError("ensureFolder", normalized, error, true);
			}
		});
	}

	public async ensureParentDirectory(filePath: string): Promise<void> {
		const parentDir = FileSystemService.getVaultParent(filePath);
		if (parentDir && parentDir !== "/") {
			await this.ensureVaultFolder(parentDir);
		}
	}

	async createVaultFileSafely(
		baseDir: string,
		filenameStem: string,
		content: string,
		options: FileCreationOptions = {},
	): Promise<TFile> {
		const normalizedDir = FileSystemService.toVaultPath(baseDir);
		const lockKey = `${normalizedDir}/${filenameStem}`;

		return this.withFileCreationLock(lockKey, async () => {
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
						if (
							error instanceof Error &&
							error.message.includes("already exists")
						)
							continue;
						throw error;
					}
				}
			}

			if (useTimestampFallback) {
				const timestamp = Date.now().toString(36);
				const fallbackPath = normalizePath(
					`${normalizedDir}/${filenameStem}-${timestamp}.md`,
				);
				return await this.vault.create(fallbackPath, content);
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
			return binary ? fsp.readFile(filePath) : fsp.readFile(filePath, "utf-8");
		} catch (error) {
			this.handleError("readNodeFile", filePath, error, true);
			throw error; // Will be caught and re-thrown by handleError, this satisfies type-checker
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
		try {
			// The for-await-of loop will automatically handle opening and closing the directory handle.
			const dirHandle = await fsp.opendir(dirPath);
			for await (const dirent of dirHandle) {
				yield dirent;
			}
		} catch (error) {
			const fsError = this.createFileSystemError(
				"readDirectory",
				dirPath,
				error,
			);
			if (fsError.isPermissionDenied) {
				// This is a common, expected error for system folders, so we log it as info.
				console.log(
					`${this.LOG_PREFIX} Permission denied while scanning directory (skipping): ${dirPath}`,
				);
			} else if (!fsError.isNotFound) {
				// Log other errors (except 'Not Found', which is also common) as warnings.
				console.warn(
					`${this.LOG_PREFIX} Could not fully read directory, skipping rest of its contents: ${dirPath}`,
					error,
				);
			}
		}
	}

	public isNotFoundError(error: unknown): boolean {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT";
	}

	/* ------------------------------------------------------------------ */
	/*                        PRIVATE IMPLEMENTATION                      */
	/* ------------------------------------------------------------------ */

	private async withLock<T>(
		lockMap: Map<string, Promise<void>>,
		lockKey: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const existingLock = lockMap.get(lockKey) || Promise.resolve();
		let releaseLock: () => void = () => {};
		const currentLock = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		lockMap.set(
			lockKey,
			existingLock.then(() => currentLock),
		);
		try {
			await existingLock;
			return await operation();
		} finally {
			releaseLock();
			if (lockMap.get(lockKey) === currentLock) {
				lockMap.delete(lockKey);
			}
		}
	}

	private async withFileCreationLock<T>(
		lockKey: string,
		operation: () => Promise<T>,
	): Promise<T> {
		return this.withLock(this.fileCreationLocks, lockKey, operation);
	}

	private async withFolderCreationLock<T>(
		lockKey: string,
		operation: () => Promise<T>,
	): Promise<T> {
		return this.withLock(this.folderCreationLocks, lockKey, operation);
	}

	private isCacheValid<T>(entry: CacheEntry<T>): boolean {
		return Date.now() - entry.timestamp < this.CACHE_TTL;
	}

	private handleError(
		operation: string,
		path: string,
		error: unknown,
		shouldThrow: boolean,
	): void {
		const fsError = this.createFileSystemError(operation, path, error);
		const nodeError = error as NodeJS.ErrnoException;
		console.error(`${this.LOG_PREFIX} ${fsError.message}`, nodeError.stack);

		const userMessage = this.getUserMessage(path, fsError.code);
		if (
			fsError.isPermissionDenied ||
			fsError.code === FileSystemErrorCode.NotDirectory
		) {
			this.noticeManager.show(userMessage);
		}

		if (shouldThrow) {
			throw fsError;
		}
	}

	private createFileSystemError(
		operation: string,
		path: string,
		error: unknown,
	): FileSystemError {
		const nodeError = error as NodeJS.ErrnoException;
		const code = this.mapErrorCode(nodeError.code);
		return new FileSystemError(operation, path, code, nodeError.message);
	}

	private mapErrorCode(code?: string): FileSystemErrorCode {
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

	private getUserMessage(path: string, code: FileSystemErrorCode): string {
		switch (code) {
			case FileSystemErrorCode.NotFound:
				return `File or folder not found: ${path}`;
			case FileSystemErrorCode.AccessDenied:
			case FileSystemErrorCode.Permission:
				return `Permission denied: ${path}`;
			case FileSystemErrorCode.IsDirectory:
				return `Expected a file, but found a directory: ${path}`;
			case FileSystemErrorCode.NotDirectory:
				return `Expected a directory, but found a file: ${path}`;
			case FileSystemErrorCode.AlreadyExists:
				return `File already exists: ${path}`;
			default:
				return `File operation failed. Check console for details.`;
		}
	}
}
