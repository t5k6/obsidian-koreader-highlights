import type { Dir } from "node:fs";
import { access, stat as fsStat, opendir, readFile } from "node:fs/promises";
import { platform } from "node:os";
import { join as joinPath } from "node:path";
import { Notice } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type {
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import { type CacheManager, memoizeAsync } from "src/utils/cache/CacheManager";
import { ConcurrencyLimiter } from "src/utils/concurrency";
import { handleFileSystemError } from "src/utils/fileUtils";
import { logger } from "src/utils/logging";

/* ------------------------------------------------------------------ */
/*                              CONSTS                                */
/* ------------------------------------------------------------------ */

const SDR_SUFFIX = ".sdr";
const METADATA_REGEX = /^metadata\.(.+)\.lua$/i;
const MAX_PARALLEL_IO = 32;

/* ------------------------------------------------------------------ */
/*                 Simple concurrency limiter (generic)               */
/* ------------------------------------------------------------------ */

const ioLimiter = new ConcurrencyLimiter(MAX_PARALLEL_IO);
const io = <T>(fn: () => Promise<T>) => ioLimiter.schedule(fn);

/* ------------------------------------------------------------------ */
/*                            MAIN CLASS                              */
/* ------------------------------------------------------------------ */

export class SDRFinder implements SettingsObserver {
	private sdrDirCache: Map<string, Promise<string[]>>;
	private metadataNameCache: Map<string, string | null>;
	private findSdrDirectoriesWithMetadataMemoized: (
		key: string,
	) => Promise<string[]>;
	private cacheKey: string | null = null;

	constructor(
		private plugin: KoreaderImporterPlugin,
		private cacheManager: CacheManager,
	) {
		this.sdrDirCache = cacheManager.createMap("sdr.dirPromise");
		this.metadataNameCache = cacheManager.createMap("sdr.metaName");

		this.findSdrDirectoriesWithMetadataMemoized = memoizeAsync(
			this.sdrDirCache,
			(key: string) => this.scan(key),
		);
		this.updateCacheKey(this.plugin.settings);
	}

	/* -------------------------- Public ----------------------------- */

	/**
	 * Provides an async iterator over all SDR directories with metadata.
	 * @yields SDR directory paths
	 */
	async *iterSdrDirectories(): AsyncGenerator<string> {
		for (const dir of await this.findSdrDirectoriesWithMetadata()) yield dir;
	}

	/**
	 * Finds all SDR directories containing metadata files.
	 * Results are cached and memoized for performance.
	 * @returns Array of SDR directory paths
	 */
	async findSdrDirectoriesWithMetadata(): Promise<string[]> {
		if (!this.cacheKey) return [];
		return this.findSdrDirectoriesWithMetadataMemoized(this.cacheKey);
	}

	/**
	 * Reads the content of a metadata.lua file from an SDR directory.
	 * @param sdrDir - Path to the SDR directory
	 * @returns File content as string or null if not found/readable
	 */
	async readMetadataFileContent(sdrDir: string): Promise<string | null> {
		const name = await this.getMetadataFileName(sdrDir);
		if (!name) return null;

		const full = joinPath(sdrDir, name);
		try {
			logger.info("SDRFinder: Reading metadata:", full);
			return await readFile(full, "utf-8");
		} catch (err) {
			handleFileSystemError("reading metadata file", full, err);
			return null;
		}
	}

	public onSettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
	): void {
		const prevKey = this.cacheKey;
		this.updateCacheKey(newSettings); // Pass new settings to update the key
		if (this.cacheKey !== prevKey) {
			this.cacheManager.clear("sdr.*");
			logger.info("SDRFinder: Settings changed, SDR caches cleared.");
		}
	}

	/* ------------------------- Private ----------------------------- */

	/**
	 * Updates the cache key based on current settings.
	 * Used to invalidate caches when settings change.
	 */
	private updateCacheKey(settings: KoreaderHighlightImporterSettings): void {
		const { koreaderMountPoint, excludedFolders, allowedFileTypes } = settings;
		this.cacheKey = [
			koreaderMountPoint ?? "nokey",
			...excludedFolders.map((s) => s.toLowerCase()),
			...allowedFileTypes.map((s) => s.toLowerCase()),
		].join("::");
	}

	/**
	 * Performs the actual filesystem scan for SDR directories.
	 * @param cacheKey - Cache key to validate scan currency
	 * @returns Array of valid SDR directory paths
	 */
	private async scan(cacheKey: string): Promise<string[]> {
		if (this.cacheKey !== cacheKey) return []; // Stale call check
		if (!(await this.checkMountPoint())) return [];

		const { koreaderMountPoint, excludedFolders } = this.plugin.settings;
		if (koreaderMountPoint === null) {
			logger.warn(`SDRFinder: Found mountpoint to be null.`);
			return [];
		}
		const root = koreaderMountPoint;
		const excluded = new Set(
			excludedFolders.map((e) => e.trim().toLowerCase()),
		);

		const results: string[] = [];
		await this.walk(root, excluded, results);
		logger.info(
			`SDRFinder: Scan finished. Found ${results.length} valid SDR directories.`,
		);
		return results;
	}

	/**
	 * Recursively walks directory tree looking for SDR directories.
	 * @param dir - Directory to search
	 * @param excluded - Set of excluded folder names (lowercase)
	 * @param out - Output array to collect results
	 */
	private async walk(
		dir: string,
		excluded: Set<string>,
		out: string[],
	): Promise<void> {
		try {
			const dh: Dir = await io(() => opendir(dir));
			try {
				for await (const e of dh) {
					const path = joinPath(dir, e.name);
					if (!e.isDirectory()) continue;
					if (excluded.has(e.name.toLowerCase())) continue;

					if (e.name.endsWith(SDR_SUFFIX)) {
						if (await this.getMetadataFileName(path)) {
							out.push(path);
							continue; // do not recurse into *.sdr
						}
					}

					if (!e.name.startsWith(".") && e.name !== "$RECYCLE.BIN") {
						await this.walk(path, excluded, out);
					}
				}
			} finally {
				await dh.close().catch(() => {});
			}
		} catch (err) {
			handleFileSystemError("reading directory", dir, err);
		}
	}

	/**
	 * Finds the metadata filename in an SDR directory.
	 * Respects allowed file type settings.
	 * @param dir - SDR directory path
	 * @returns Metadata filename or null if not found
	 */
	private async getMetadataFileName(dir: string): Promise<string | null> {
		const cached = this.metadataNameCache.get(dir);
		if (cached !== undefined) return cached;

		const { allowedFileTypes } = this.plugin.settings;
		const allow = new Set(
			allowedFileTypes.map((t) => t.trim().toLowerCase()).filter(Boolean),
		);
		const allowAll = allow.size === 0;

		let dh: Dir | undefined;
		try {
			dh = await io(() => opendir(dir));
			for await (const entry of dh) {
				if (!entry.isFile()) continue;
				const m = entry.name.match(METADATA_REGEX);
				if (!m) continue;

				const ext = m[1]?.toLowerCase();
				if (allowAll || allow.has(ext)) {
					this.metadataNameCache.set(dir, entry.name);
					return entry.name;
				}
			}
		} catch (err) {
			handleFileSystemError("reading SDR directory", dir, err);
		} finally {
			await dh?.close().catch(() => {});
		}

		this.metadataNameCache.set(dir, null);
		return null;
	}

	/* ---------- mount-point handling / auto-detect ----------------- */

	/**
	 * Checks if mount point is accessible, attempts auto-detection if not.
	 * Updates plugin settings with auto-detected path.
	 * @returns True if a usable mount point is available
	 */
	async checkMountPoint(): Promise<boolean> {
		const { koreaderMountPoint } = this.plugin.settings;
		if (koreaderMountPoint && (await this.isUsableDir(koreaderMountPoint)))
			return true;

		logger.warn(
			"SDRFinder: Configured mount point not accessible – attempting auto-detect.",
		);

		for (const candidate of await this.detectCandidates()) {
			if (await this.isUsableDir(candidate)) {
				this.plugin.settings.koreaderMountPoint = candidate;
				new Notice(`KOReader: auto-detected device at "${candidate}"`, 5_000);
				logger.info("Using auto-detected mount point:", candidate);
				this.updateCacheKey(this.plugin.settings);
				return true;
			}
		}
		logger.warn(
			"SDRFinder: Failed to find or access any KOReader mount point.",
		);
		return false;
	}

	/**
	 * Checks if a path exists and is a directory.
	 * @param p - Path to check
	 * @returns True if path is a usable directory
	 */
	private async isUsableDir(p: string): Promise<boolean> {
		try {
			return (await fsStat(p)).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * Detects potential KOReader mount points by platform.
	 * Looks for Kobo devices on macOS/Linux and KoboReader.sqlite on Windows.
	 * @returns Array of candidate mount point paths
	 */
	private async detectCandidates(): Promise<string[]> {
		const out: string[] = [];
		if (platform() === "darwin") {
			const vols = await opendir("/Volumes").catch(() => null); // no limiter
			if (vols) {
				try {
					for await (const e of vols) {
						if (e.isDirectory() && e.name.toLowerCase().includes("kobo")) {
							out.push(joinPath("/Volumes", e.name));
						}
					}
				} finally {
					await vols.close().catch(() => {});
				}
			}
		} else if (platform() === "linux") {
			for (const root of ["/media", "/run/media"]) {
				const users = await opendir(root).catch(() => null);
				if (!users) continue;
				try {
					for await (const user of users) {
						if (!user.isDirectory()) continue;
						const userPath = joinPath(root, user.name);
						const devs = await opendir(userPath).catch(() => null);
						if (!devs) continue;
						try {
							for await (const dev of devs) {
								if (
									dev.isDirectory() &&
									dev.name.toLowerCase().includes("kobo")
								) {
									out.push(joinPath(userPath, dev.name));
								}
							}
						} finally {
							await devs.close().catch(() => {});
						}
					}
				} finally {
					await users.close().catch(() => {});
				}
			}
		} else if (platform() === "win32") {
			// Windows: look for KoboReader.sqlite in the drive root (E:/… etc.)
			for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
				const root = `${letter}:/`; // <-- forward-slash
				try {
					await access(`${root}KoboReader.sqlite`); // simpler & separator-agnostic
					out.push(root); // will later be stat()-checked
				} catch {
					/* file not found – keep searching */
				}
			}
		}
		return out;
	}
}
