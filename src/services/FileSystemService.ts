import { promises as fsp } from "node:fs";
import path, { posix as posixPath } from "node:path";
import {
	normalizePath,
	type Plugin,
	type TFile,
	type TFolder,
	type Vault,
} from "obsidian";
import type { CacheManager } from "src/lib/cache";
import {
	KeyedQueue,
	readWithRetry,
	removeWithRetry,
	renameWithRetry,
	writeBinaryWithRetry,
} from "src/lib/concurrency";
import { withFsRetry } from "src/lib/concurrency/fsRetry";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type { AppFailure, FileSystemFailure } from "src/lib/errors/resultTypes";
import { isTFile, isTFolder } from "src/lib/obsidian/typeguards";
import { normalizeFileNamePiece } from "src/lib/pathing/pathingUtils";
import type { Cache } from "src/types";

/* ------------------------------------------------------------------ */
/*                              TYPES                                 */
/* ------------------------------------------------------------------ */

// Branded types to distinguish vault vs system paths at compile time.
export type VaultPath = string & { __vault: true };
export type SystemPath = string & { __system: true };

const brandVault = (p: string): VaultPath => p as VaultPath;
const brandSystem = (p: string): SystemPath => p as SystemPath;

export enum FileSystemErrorCode {
	NotFound = "ENOENT",
	AccessDenied = "EACCES",
	Permission = "EPERM",
	IsDirectory = "EISDIR",
	NotDirectory = "ENOTDIR",
	AlreadyExists = "EEXIST",
	Unknown = "UNKNOWN",
}

// Structural guard to avoid relying on instanceof across modules
function looksLikeFileSystemError(e: unknown): e is {
	code?: string | FileSystemErrorCode;
	isNotFound?: boolean;
	name?: string;
} {
	if (!e || typeof e !== "object") return false;
	const anyE = e as any;
	const hasCode = typeof anyE.code === "string";
	const hasIsNotFound = typeof anyE.isNotFound === "boolean";
	const hasName = anyE.name === "FileSystemError";
	return (hasCode || hasIsNotFound) && hasName;
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
		// Ensure proper prototype chain for robust instanceof behavior across modules
		Object.setPrototypeOf(this, new.target.prototype);
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
	private readonly LOG_PREFIX = "KOReader Importer: FileSystemService:";
	private readonly folderExistsCache!: Cache<string, CacheEntry<boolean>>;
	private readonly nodeStatsCache!: Cache<
		string,
		CacheEntry<Result<import("node:fs").Stats, FileSystemFailure>>
	>;
	private readonly CACHE_TTL = 5000;
	private readonly keyedQueue = new KeyedQueue();
	private renameReplaceSupported: boolean | null = null;
	private loggedCapabilityOnce = false;
	private folderScanCache!: import("src/lib/cache").LruCache<
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

	public static normalizeSystemPath(p: string | null | undefined): SystemPath {
		if (!p) return brandSystem("");
		let s = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
		if (s.length > 1 && s.endsWith("/")) {
			s = s.slice(0, -1);
		}
		return brandSystem(s);
	}

	/**
	 * Converts a path to a canonical, vault-relative format.
	 * This is the single source of truth for path normalization.
	 */
	public static toVaultPath(rawPath: string | null | undefined): VaultPath {
		if (!rawPath) return brandVault("");
		const p = normalizePath(rawPath.trim());
		if (p === "/" || p === "." || p === "") return brandVault("");
		return brandVault(p.replace(/^\/+/, "").replace(/\/+$/, ""));
	}

	/**
	 * Returns the basename (final segment) of a vault path string without requiring an instance.
	 */
	public static vaultBasenameOf(p: string): string {
		const norm = FileSystemService.toVaultPath(p) as unknown as string;
		const parts = norm.split("/");
		return parts[parts.length - 1] ?? "";
	}

	/**
	 * Returns the extension (including the dot) of a vault path's basename, or empty string.
	 */
	public static vaultExtnameOf(p: string): string {
		const base = FileSystemService.vaultBasenameOf(p);
		const idx = base.lastIndexOf(".");
		return idx >= 0 ? base.slice(idx) : "";
	}

	/**
	 * Normalize adapter/Node error shapes to a stable not-found predicate.
	 */
	public static isNotFound(err: unknown): boolean {
		const e: any = err as any;
		// Prefer structural detection over instanceof for robustness
		if (looksLikeFileSystemError(e)) {
			const c: string | FileSystemErrorCode | undefined = (e as any).code as
				| string
				| FileSystemErrorCode
				| undefined;
			return c === FileSystemErrorCode.NotFound || e.isNotFound === true;
		}
		// Fallback to common Node/adapter code shapes
		const code = (
			typeof (e as any)?.code === "string"
				? (e as any).code
				: typeof (e as any)?.Code === "string"
					? (e as any).Code
					: undefined
		) as string | undefined;
		return code === "ENOENT";
	}

	public static getVaultParent(vaultPath: string): string {
		const parent = posixPath.dirname(vaultPath);
		return parent === "." ? "" : parent;
	}

	/**
	 * Join path segments using POSIX semantics (for vaults) and normalize.
	 * Returns a vault-relative path without a leading slash.
	 */
	public joinVaultPath(...segments: string[]): VaultPath {
		const joined = posixPath.join(
			...segments.map((s) => FileSystemService.toVaultPath(s)),
		);
		return FileSystemService.toVaultPath(joined);
	}

	/** Get the normalized parent directory of a vault path. */
	public vaultDirname(p: string): VaultPath {
		return brandVault(posixPath.dirname(FileSystemService.toVaultPath(p)));
	}

	/** Get the basename (final segment) of a vault path. */
	public vaultBasename(p: string): string {
		return FileSystemService.vaultBasenameOf(p);
	}

	/** Get the extension (including the dot) of a vault path's basename, or empty string. */
	public vaultExtname(p: string): string {
		return FileSystemService.vaultExtnameOf(p);
	}

	/** Cheap dev-time check for a correctly normalized vault path. */
	public isNormalizedVaultPath(p: string): boolean {
		return p === (FileSystemService.toVaultPath(p) as unknown as string);
	}

	/** Join OS-native system path segments. */
	public joinSystemPath(...segments: string[]): SystemPath {
		return brandSystem(path.join(...segments));
	}

	/** Get dirname of an OS-native system path. */
	public systemDirname(p: string): SystemPath {
		return brandSystem(path.dirname(p));
	}

	/** Get basename of an OS-native system path. */
	public systemBasename(p: string): string {
		return path.basename(p);
	}

	/** Dev-only assertion for vault paths (no-op in production builds). */
	public assertVaultPath(p: string, ctx?: string): void {
		if (process.env.NODE_ENV === "development") {
			const ok = this.isNormalizedVaultPath(p);
			if (!ok) {
				console.warn(
					`[Path] Non-normalized vault path${ctx ? ` (${ctx})` : ""}:`,
					p,
				);
			}
		}
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
		return child.startsWith(`${ancestor}/`);
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

		if (!isTFolder(root)) {
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
			if (isTFile(entry)) {
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
				if (isTFile(child)) {
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
				changed !== "" && rootPath.startsWith(`${changed}/`);

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
	 * Result-based API.
	 */
	public async readVaultBinary(
		vaultPath: string,
	): Promise<Result<ArrayBuffer, AppFailure>> {
		const p = FileSystemService.toVaultPath(vaultPath) as unknown as string;
		try {
			const data = await readWithRetry(this.vault.adapter, p, {
				maxAttempts: 5,
				baseDelayMs: 30,
			});
			return ok(data);
		} catch (e: any) {
			const code = e?.code ?? e?.Code;
			if (code === "ENOENT") return err({ kind: "NotFound", path: p });
			if (code === "EACCES" || code === "EPERM")
				return err({ kind: "PermissionDenied", path: p });
			return err({ kind: "ReadFailed", path: p, cause: e });
		}
	}

	/**
	 * Write binary file via the vault adapter using a vault-relative path.
	 * Result-based API. Ensures parent directory exists.
	 */
	public async writeVaultBinary(
		vaultPath: string,
		data: ArrayBuffer,
	): Promise<Result<void, AppFailure>> {
		const p = FileSystemService.toVaultPath(vaultPath) as unknown as string;
		const ensured = await this.ensureParentDirectory(p);
		if (isErr(ensured)) return ensured;
		try {
			await writeBinaryWithRetry(this.vault.adapter, p, data, {
				maxAttempts: 4,
				baseDelayMs: 30,
			});
			return ok(void 0);
		} catch (e: any) {
			const code = e?.code ?? e?.Code;
			if (code === "EACCES" || code === "EPERM")
				return err({ kind: "PermissionDenied", path: p });
			if (code === "ENOTDIR") return err({ kind: "NotADirectory", path: p });
			if (code === "EISDIR") return err({ kind: "IsADirectory", path: p });
			return err({ kind: "WriteFailed", path: p, cause: e });
		}
	}

	/**
	 * Atomically write a binary file. Result-based.
	 */
	public async writeVaultBinaryAtomic(
		vaultPath: string,
		data: ArrayBuffer,
	): Promise<Result<void, AppFailure>> {
		const dst = FileSystemService.toVaultPath(vaultPath) as unknown as string;
		const ensured = await this.ensureParentDirectory(dst);
		if (isErr(ensured)) return ensured;

		return this.keyedQueue.run(`atomic:${dst}`, async () => {
			const tmp = `${dst}.__tmp__${Date.now()}-${Math.random()
				.toString(36)
				.slice(2)}`;
			try {
				await writeBinaryWithRetry(this.vault.adapter, tmp, data, {
					maxAttempts: 4,
					baseDelayMs: 30,
				});
				const replaceSupported = await this.probeRenameReplaceSupport();
				if (replaceSupported) {
					try {
						await renameWithRetry(this.vault.adapter, tmp, dst, {
							maxAttempts: 6,
							baseDelayMs: 30,
						});
						return ok(void 0);
					} catch {
						// fall through to backup-swap
					}
				}
				return await this.replaceViaBackupSwapResult(dst, tmp);
			} catch (e: any) {
				const code = e?.code ?? e?.Code;
				if (code === "EACCES" || code === "EPERM")
					return err({ kind: "PermissionDenied", path: dst });
				if (code === "ENOTDIR")
					return err({ kind: "NotADirectory", path: dst });
				if (code === "EISDIR") return err({ kind: "IsADirectory", path: dst });
				return err({ kind: "WriteFailed", path: dst, cause: e });
			} finally {
				try {
					await this.vault.adapter.remove(tmp);
				} catch {}
			}
		});
	}

	private async replaceViaBackupSwapResult(
		dst: string,
		tmp: string,
	): Promise<Result<void, AppFailure>> {
		const bak = `${dst}.__bak__`;
		try {
			await this.vault.adapter.remove(bak);
		} catch {}
		if (await this.vault.adapter.exists(dst)) {
			try {
				await renameWithRetry(this.vault.adapter, dst, bak, {
					maxAttempts: 6,
					baseDelayMs: 30,
				});
			} catch {
				try {
					await removeWithRetry(this.vault.adapter, dst, {
						maxAttempts: 3,
						baseDelayMs: 25,
					});
				} catch {}
			}
		}
		try {
			await renameWithRetry(this.vault.adapter, tmp, dst, {
				maxAttempts: 6,
				baseDelayMs: 30,
			});
			try {
				await this.vault.adapter.remove(bak);
			} catch {}
			return ok(void 0);
		} catch (placeErr: any) {
			if (await this.vault.adapter.exists(bak)) {
				try {
					await renameWithRetry(this.vault.adapter, bak, dst, {
						maxAttempts: 6,
						baseDelayMs: 30,
					});
				} catch {}
			}
			const code = placeErr?.code ?? placeErr?.Code;
			if (code === "EACCES" || code === "EPERM")
				return err({ kind: "PermissionDenied", path: dst });
			if (code === "ENOTDIR") return err({ kind: "NotADirectory", path: dst });
			if (code === "EISDIR") return err({ kind: "IsADirectory", path: dst });
			return err({ kind: "WriteFailed", path: dst, cause: placeErr });
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
		const buffer = new TextEncoder().encode(content).buffer;
		return this.writeVaultBinaryAtomic(vaultPath, buffer);
	}

	/** Result-based append of UTF-8 text to an existing vault file (creates parent dirs if needed). */
	public async appendVaultText(
		vaultPath: string,
		text: string,
	): Promise<Result<void, AppFailure>> {
		const p = FileSystemService.toVaultPath(vaultPath) as unknown as string;
		const ensured = await this.ensureParentDirectory(p);
		if (isErr(ensured)) return ensured;
		try {
			await withFsRetry(() => this.vault.adapter.append(p, text), {
				maxAttempts: 6,
				baseDelayMs: 40,
			});
			return ok(void 0);
		} catch (e: any) {
			const code = e?.code ?? e?.Code;
			if (code === "ENOENT") return err({ kind: "NotFound", path: p });
			if (code === "EACCES" || code === "EPERM")
				return err({ kind: "PermissionDenied", path: p });
			if (code === "ENOTDIR") return err({ kind: "NotADirectory", path: p });
			if (code === "EISDIR") return err({ kind: "IsADirectory", path: p });
			return err({ kind: "WriteFailed", path: p, cause: e });
		}
	}

	/** Result-based read of UTF-8 text from vault. */
	public async readVaultText(
		vaultPath: string,
	): Promise<Result<string, AppFailure>> {
		const bin = await this.readVaultBinary(vaultPath);
		if (isErr(bin)) return bin;
		try {
			return ok(new TextDecoder().decode(bin.value));
		} catch (e: any) {
			const p = FileSystemService.toVaultPath(vaultPath) as unknown as string;
			return err({ kind: "ReadFailed", path: p, cause: e });
		}
	}

	/* ------------------------------------------------------------------ */
	/*                         AUTO-ROUTING HELPERS                        */
	/* ------------------------------------------------------------------ */

	/** Result-based read of binary (auto-route vault vs node). */
	async readBinaryAuto(
		filePath: string,
	): Promise<Result<Uint8Array, AppFailure>> {
		if (path.isAbsolute(filePath)) {
			const res = await this.readNodeFile(filePath, true);
			if (isErr(res)) return res as any;
			return ok(res.value as Uint8Array);
		} else {
			const res = await this.readVaultBinary(filePath);
			if (isErr(res)) return res;
			return ok(new Uint8Array(res.value));
		}
	}

	/** Result-based write of binary (auto-route vault vs node). */
	async writeBinaryAuto(
		filePath: string,
		data: Uint8Array,
	): Promise<Result<void, AppFailure>> {
		if (path.isAbsolute(filePath)) {
			return this.writeNodeFile(filePath, data) as any;
		} else {
			const arrayBuffer = (data.buffer as ArrayBuffer).slice(
				data.byteOffset,
				data.byteOffset + data.byteLength,
			);
			return this.writeVaultBinary(filePath, arrayBuffer);
		}
	}

	/* ------------------------------------------------------------------ */
	/*                         VAULT OPERATIONS                           */
	/* ------------------------------------------------------------------ */

	/** Result-based write of UTF-8 text to a vault path (create or modify). */
	public async writeVaultFile(
		vaultPath: string,
		content: string,
	): Promise<Result<TFile, AppFailure>> {
		const p = FileSystemService.toVaultPath(vaultPath) as unknown as string;
		const ensured = await this.ensureParentDirectory(p);
		if (isErr(ensured)) return ensured as any;
		const existing = this.vault.getAbstractFileByPath(p);
		if (isTFolder(existing)) {
			return err({ kind: "NotADirectory", path: p });
		}
		// If something exists at the path and it's not a folder, treat it as a file and modify it.
		if (existing) {
			try {
				await this.vault.modify(existing as TFile, content);
				return ok(existing as TFile);
			} catch (e: any) {
				const code = e?.code ?? e?.Code;
				if (code === "EACCES" || code === "EPERM")
					return err({ kind: "PermissionDenied", path: p });
				if (code === "ENOTDIR") return err({ kind: "NotADirectory", path: p });
				if (code === "EISDIR") return err({ kind: "IsADirectory", path: p });
				return err({ kind: "WriteFailed", path: p, cause: e });
			}
		}
		try {
			const created = await this.vault.create(p, content);
			return ok(created);
		} catch (e: any) {
			const code = e?.code ?? e?.Code;
			if (code === "EEXIST") {
				const now = this.vault.getAbstractFileByPath(p);
				if (isTFolder(now)) return err({ kind: "NotADirectory", path: p });
				if (now) {
					try {
						await this.vault.modify(now as TFile, content);
						return ok(now as TFile);
					} catch (m: any) {
						const mcode = m?.code ?? m?.Code;
						if (mcode === "EACCES" || mcode === "EPERM")
							return err({ kind: "PermissionDenied", path: p });
						if (mcode === "ENOTDIR")
							return err({ kind: "NotADirectory", path: p });
						if (mcode === "EISDIR")
							return err({ kind: "IsADirectory", path: p });
						return err({ kind: "WriteFailed", path: p, cause: m });
					}
				}
			}
			if (code === "EACCES" || code === "EPERM")
				return err({ kind: "PermissionDenied", path: p });
			if (code === "ENOTDIR") return err({ kind: "NotADirectory", path: p });
			if (code === "EISDIR") return err({ kind: "IsADirectory", path: p });
			return err({ kind: "WriteFailed", path: p, cause: e });
		}
	}

	public async ensurePluginDataDirExists(): Promise<Result<void, AppFailure>> {
		const dir = this.getPluginDataDir();
		return this.ensureAdapterFolder(dir);
	}

	// Raw directory listing removed; use listVaultDir() which returns Result

	/** Result-based list of a vault directory (canonical). */
	public async listVaultDir(
		vaultPath: string,
	): Promise<Result<{ files: string[]; folders: string[] }, AppFailure>> {
		const dir = FileSystemService.toVaultPath(vaultPath) as unknown as string;
		try {
			const r = await this.vault.adapter.list(dir);
			return ok(r);
		} catch (e: any) {
			const code = e?.code ?? e?.Code;
			if (code === "ENOENT") return err({ kind: "NotFound", path: dir });
			if (code === "EACCES" || code === "EPERM")
				return err({ kind: "PermissionDenied", path: dir });
			if (code === "ENOTDIR") return err({ kind: "NotADirectory", path: dir });
			if (code === "EISDIR") return err({ kind: "IsADirectory", path: dir });
			return err({ kind: "ReadFailed", path: dir, cause: e });
		}
	}

	/** Result-based remove of a vault path (canonical). */
	public async removeVaultPath(
		vaultPath: string,
	): Promise<Result<void, AppFailure>> {
		const p = FileSystemService.toVaultPath(vaultPath) as unknown as string;
		try {
			await removeWithRetry(this.vault.adapter, p, {
				maxAttempts: 3,
				baseDelayMs: 25,
			});
			return ok(void 0);
		} catch (e: any) {
			const code = e?.code ?? e?.Code;
			if (code === "ENOENT") return err({ kind: "NotFound", path: p });
			if (code === "EACCES" || code === "EPERM")
				return err({ kind: "PermissionDenied", path: p });
			if (code === "ENOTDIR") return err({ kind: "NotADirectory", path: p });
			return err({ kind: "WriteFailed", path: p, cause: e });
		}
	}

	/** Result-based rename of a vault path with retry. */
	public async renameVaultPath(
		fromPath: string,
		toPath: string,
	): Promise<Result<void, AppFailure>> {
		const from = FileSystemService.toVaultPath(fromPath) as unknown as string;
		const to = FileSystemService.toVaultPath(toPath) as unknown as string;
		try {
			await renameWithRetry(this.vault.adapter, from, to, {
				maxAttempts: 6,
				baseDelayMs: 30,
			});
			return ok(void 0);
		} catch (e: any) {
			const code = e?.code ?? e?.Code;
			if (code === "ENOENT") return err({ kind: "NotFound", path: from });
			if (code === "EACCES" || code === "EPERM")
				return err({ kind: "PermissionDenied", path: from });
			if (code === "ENOTDIR") return err({ kind: "NotADirectory", path: from });
			if (code === "EISDIR") return err({ kind: "IsADirectory", path: from });
			return err({ kind: "WriteFailed", path: to, cause: e });
		}
	}

	public async vaultExists(vaultPath: string): Promise<boolean> {
		return this.vault.adapter.exists(FileSystemService.toVaultPath(vaultPath));
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
		const ensured = await this.ensurePluginDataDirExists();
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
			if ((r as any).error?.kind === "NotFound") return null;
			return null;
		}
		try {
			return JSON.parse(r.value) as T;
		} catch {
			return null;
		}
	}

	public async existsPluginData(relPath: string): Promise<boolean> {
		const p = this.joinPluginDataPath(relPath);
		return this.vaultExists(p);
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
		const normalized = FileSystemService.toVaultPath(folderPath);
		if (!normalized) return ok(void 0);

		// If the path is inside the hidden config dir, we must use the adapter.
		if (normalized.startsWith(this.vault.configDir)) {
			return this.ensureAdapterFolder(normalized);
		}

		return this.keyedQueue.run(`folder:${normalized}`, async () => {
			const cached = this.folderExistsCache.get(normalized);
			if (cached && this.isCacheValid(cached)) return ok(void 0);

			try {
				const abstract = this.vault.getAbstractFileByPath(normalized);
				if (isTFolder(abstract)) {
					this.folderExistsCache.set(normalized, {
						value: true,
						timestamp: Date.now(),
					});
					return ok(void 0);
				}
				if (abstract) {
					return err({ kind: "NotADirectory", path: normalized });
				}
				await this.vault.createFolder(normalized);
				this.folderExistsCache.set(normalized, {
					value: true,
					timestamp: Date.now(),
				});
				return ok(void 0);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException)?.code;
				if (
					code === "EEXIST" ||
					(error instanceof Error &&
						(/already exists/i.test(error.message) ||
							/Folder already exists/i.test(error.message)))
				) {
					this.folderExistsCache.set(normalized, {
						value: true,
						timestamp: Date.now(),
					});
					return ok(void 0);
				}
				const code2 = (error as any)?.code ?? (error as any)?.Code;
				if (code2 === "EACCES" || code2 === "EPERM")
					return err({ kind: "PermissionDenied", path: normalized });
				if (code2 === "ENOTDIR")
					return err({ kind: "NotADirectory", path: normalized });
				return err({ kind: "WriteFailed", path: normalized, cause: error });
			}
		});
	}

	public async ensureParentDirectory(
		filePath: string,
	): Promise<Result<void, AppFailure>> {
		const parentDir = FileSystemService.getVaultParent(filePath);
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
		const p = FileSystemService.toVaultPath(folderPath) as unknown as string;
		if (!p) return err({ kind: "ConfigMissing", field: "folderPath" });

		if (opts?.ensure) {
			const ensured = await this.ensureVaultFolder(p);
			if (isErr(ensured)) return ensured as Result<any, AppFailure>;
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
		const normalized = FileSystemService.toVaultPath(
			vaultRelPath,
		) as unknown as string;
		if (!normalized) return ok(void 0);
		return this.keyedQueue.run(`folder-adapter:${normalized}`, async () => {
			try {
				if (await this.vault.adapter.exists(normalized)) return ok(void 0);
				const segments = normalized.split("/");
				let current = "";
				for (const seg of segments) {
					current = current ? `${current}/${seg}` : seg;
					// eslint-disable-next-line no-await-in-loop
					if (!(await this.vault.adapter.exists(current))) {
						// eslint-disable-next-line no-await-in-loop
						await this.vault.adapter.mkdir(current);
					}
				}
				return ok(void 0);
			} catch (e: any) {
				const code = e?.code ?? e?.Code;
				if (code === "EEXIST") return ok(void 0);
				if (code === "EACCES" || code === "EPERM")
					return err({ kind: "PermissionDenied", path: normalized });
				if (code === "ENOTDIR")
					return err({ kind: "NotADirectory", path: normalized });
				return err({ kind: "WriteFailed", path: normalized, cause: e });
			}
		});
	}

	public async createVaultFileUnique(
		baseDir: string,
		desiredStem: string,
		content: string,
		ext: string = "md",
	): Promise<TFile> {
		const dir = FileSystemService.toVaultPath(baseDir);
		const stem = normalizeFileNamePiece(desiredStem);
		const e = ext.replace(/^\./, "");

		return this.keyedQueue.run(`file:${dir}/${stem}`, async () => {
			await this.ensureVaultFolder(dir);

			for (let i = 0; i < 1000; i++) {
				const suffix = i === 0 ? "" : ` (${i})`;
				const candidateStem = `${stem}${suffix}`;
				const finalPath = normalizePath(`${dir}/${candidateStem}.${e}`);
				try {
					return await this.vault.create(finalPath, content);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException)?.code;
					const exists =
						code === "EEXIST" ||
						(error instanceof Error && /already exists/i.test(error.message));
					if (exists) continue; // try next suffix
					throw error;
				}
			}

			const ts = Date.now().toString(36);
			const fallback = normalizePath(`${dir}/${stem}-${ts}.${e}`);
			return this.vault.create(fallback, content);
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
		const dir = FileSystemService.toVaultPath(baseDir);
		const stem = normalizeFileNamePiece(desiredStem);
		const e = ext.replace(/^\./, "");

		return this.keyedQueue.run(`file:${dir}/${stem}`, async () => {
			const candidatePath = normalizePath(`${dir}/${stem}.${e}`);
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
			await withFsRetry(() => fsp.access(filePath));
			return true;
		} catch {
			return false;
		}
	}

	/** Result-based file read (replaces old readNodeFile). */
	async readNodeFile(
		filePath: string,
		binary: boolean = false,
	): Promise<Result<string | Uint8Array, FileSystemFailure>> {
		try {
			if (binary) {
				const data = await withFsRetry(() => fsp.readFile(filePath));
				return ok(data as Uint8Array);
			} else {
				const data = await withFsRetry(
					() => fsp.readFile(filePath, "utf-8") as Promise<string>,
				);
				return ok(data as string);
			}
		} catch (error: any) {
			// Map to FileSystemFailure kinds
			const code = (error?.code ?? error?.Code) as string | undefined;
			switch (code) {
				case "ENOENT":
					return err({ kind: "NotFound", path: filePath });
				case "EACCES":
				case "EPERM":
					return err({ kind: "PermissionDenied", path: filePath });
				case "EISDIR":
					return err({ kind: "IsADirectory", path: filePath });
				case "ENOTDIR":
					return err({ kind: "NotADirectory", path: filePath });
				default:
					return err({ kind: "ReadFailed", path: filePath, cause: error });
			}
		}
	}

	async writeNodeFile(
		filePath: string,
		data: string | Uint8Array,
	): Promise<Result<void, FileSystemFailure>> {
		try {
			await withFsRetry(async () => {
				await fsp.mkdir(path.dirname(filePath), { recursive: true });
				await fsp.writeFile(filePath, data);
			});
			this.nodeStatsCache.delete(filePath);
			return ok(void 0);
		} catch (error: any) {
			const code = (error?.code ?? error?.Code) as string | undefined;
			switch (code) {
				case "EACCES":
				case "EPERM":
					return err({ kind: "PermissionDenied", path: filePath });
				case "ENOTDIR":
					return err({ kind: "NotADirectory", path: filePath });
				case "EISDIR":
					return err({ kind: "IsADirectory", path: filePath });
				default:
					return err({ kind: "WriteFailed", path: filePath, cause: error });
			}
		}
	}

	async deleteNodeFile(
		filePath: string,
	): Promise<Result<void, FileSystemFailure>> {
		try {
			await withFsRetry(() => fsp.unlink(filePath));
			this.nodeStatsCache.delete(filePath);
			return ok(void 0);
		} catch (error: any) {
			const code = (error?.code ?? error?.Code) as string | undefined;
			switch (code) {
				case "ENOENT":
					return err({ kind: "NotFound", path: filePath });
				case "EACCES":
				case "EPERM":
					return err({ kind: "PermissionDenied", path: filePath });
				case "ENOTDIR":
					return err({ kind: "NotADirectory", path: filePath });
				default:
					return err({ kind: "WriteFailed", path: filePath, cause: error });
			}
		}
	}

	public async getNodeStats(
		filePath: string,
	): Promise<Result<import("node:fs").Stats, FileSystemFailure>> {
		const cached = this.nodeStatsCache.get(filePath);
		if (cached && this.isCacheValid(cached)) return cached.value;

		try {
			const stats = await withFsRetry(() => fsp.stat(filePath));
			const res = ok(stats);
			this.nodeStatsCache.set(filePath, { value: res, timestamp: Date.now() });
			return res;
		} catch (error: any) {
			const code = (error?.code ?? error?.Code) as string | undefined;
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

	async *iterateNodeDirectory(
		dirPath: string,
		opts?: {
			continueOnError?: boolean;
			onError?: (e: FileSystemError) => void;
		},
	): AsyncIterable<import("node:fs").Dirent> {
		let dirHandle: import("node:fs").Dir | undefined;
		try {
			dirHandle = await withFsRetry(() => fsp.opendir(dirPath));
			for await (const dirent of dirHandle) yield dirent;
		} catch (error) {
			const fsError = this.asFileSystemError("readDirectory", dirPath, error);
			opts?.onError?.(fsError);
			const continueOnError = opts?.continueOnError ?? true;
			if (!continueOnError) throw fsError;
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

	/**
	 * Moves a file within the vault, preferring an atomic rename and falling back to copy+delete.
	 * Uses retry logic for transient filesystem errors.
	 */
	public async moveVaultPath(
		src: string,
		dst: string,
	): Promise<Result<void, AppFailure>> {
		const s = FileSystemService.toVaultPath(src) as unknown as string;
		const d = FileSystemService.toVaultPath(dst) as unknown as string;
		const ensured = await this.ensureParentDirectory(d);
		if (isErr(ensured)) return ensured;

		try {
			await renameWithRetry(this.vault.adapter, s, d, {
				maxAttempts: 6,
				baseDelayMs: 30,
			});
			return ok(void 0);
		} catch (e) {
			console.info(
				`${this.LOG_PREFIX} rename failed for ${s} -> ${d}, falling back to copy+delete.`,
				e,
			);
		}

		const dataRes = await this.readVaultBinary(s);
		if (isErr(dataRes)) return dataRes;
		const writeRes = await this.writeVaultBinaryAtomic(d, dataRes.value);
		if (isErr(writeRes)) return writeRes;
		const rmRes = await this.removeVaultPath(s);
		if (isErr(rmRes)) return rmRes;
		return ok(void 0);
	}

	/**
	 * Attempts an atomic rename only. Returns true on success, false if rename failed.
	 * Does NOT fall back to copy+delete. Caller controls any fallback behavior.
	 */
	public async tryRenameVaultPath(
		oldPath: string,
		newPath: string,
	): Promise<Result<boolean, AppFailure>> {
		const s = FileSystemService.toVaultPath(oldPath) as unknown as string;
		const d = FileSystemService.toVaultPath(newPath) as unknown as string;
		const ensured = await this.ensureParentDirectory(d);
		if (isErr(ensured)) return ensured as any;
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
		const p = FileSystemService.toVaultPath(vaultPath);
		const adapterAny = this.vault.adapter as any;
		try {
			if (typeof adapterAny.stat === "function") {
				const st = await adapterAny.stat(p);
				if (st) {
					const mtime = Number(st.mtime ?? st.modifiedTime ?? 0);
					return { mtime: Number.isNaN(mtime) ? 0 : mtime };
				}
			}
			return null;
		} catch {
			return null;
		}
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

		await visit(FileSystemService.toVaultPath(root));
		return out;
	}
}
