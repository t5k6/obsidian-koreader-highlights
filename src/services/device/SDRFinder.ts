import { platform } from "node:os";
import path, { join as joinPath } from "node:path";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type {
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import { type CacheManager, memoizeAsync } from "src/utils/cache/CacheManager";
import { ConcurrencyLimiter } from "src/utils/concurrency";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";

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
	private readonly SCOPE = "SDRFinder";
	private sdrDirCache: Map<string, Promise<string[]>>;
	private metadataNameCache: Map<string, string | null>;
	private findSdrDirectoriesWithMetadataMemoized: (
		key: string,
	) => Promise<string[]>;
	private cacheKey: string | null = null;

	constructor(
		private plugin: KoreaderImporterPlugin,
		private cacheManager: CacheManager,
		private fs: FileSystemService,
		private loggingService: LoggingService,
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

		const fullPath = joinPath(sdrDir, name);
		try {
			this.loggingService.info(this.SCOPE, "Reading metadata:", fullPath);
			return await this.fs.readNodeFile(fullPath);
		} catch (err) {
			this.loggingService.error(
				this.SCOPE,
				`Failed to read metadata file: ${fullPath}`,
				err,
			);
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
			this.loggingService.info(
				this.SCOPE,
				"Settings changed, SDR caches cleared.",
			);
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
		const { isReady } = await this.checkMountPoint();
		if (!isReady) return [];

		const { koreaderMountPoint, excludedFolders } = this.plugin.settings;
		if (koreaderMountPoint === null) {
			this.loggingService.warn(this.SCOPE, `Found mountpoint to be null.`);
			return [];
		}
		const root = koreaderMountPoint;
		const excluded = new Set(
			excludedFolders.map((e) => e.trim().toLowerCase()),
		);

		const results: string[] = [];
		await this.walk(root, excluded, results);
		this.loggingService.info(
			this.SCOPE,
			`Scan finished. Found ${results.length} valid SDR directories.`,
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
		for await (const entry of this.fs.iterateNodeDirectory(dir)) {
			if (!entry.isDirectory()) continue;
			if (excluded.has(entry.name.toLowerCase())) continue;

			const fullPath = joinPath(dir, entry.name);

			if (entry.name.endsWith(SDR_SUFFIX)) {
				if (await this.getMetadataFileName(fullPath)) {
					out.push(fullPath);
				}
			} else if (!entry.name.startsWith(".") && entry.name !== "$RECYCLE.BIN") {
				await this.walk(fullPath, excluded, out);
			}
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

		for await (const entry of this.fs.iterateNodeDirectory(dir)) {
			if (!entry.isFile()) continue;

			const match = entry.name.match(METADATA_REGEX);
			if (match) {
				const ext = match[1]?.toLowerCase();
				if (allowAll || allow.has(ext)) {
					this.metadataNameCache.set(dir, entry.name);
					return entry.name;
				}
			}
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
	async checkMountPoint(): Promise<{
		isReady: boolean;
		autoDetectedPath?: string;
	}> {
		const { koreaderMountPoint } = this.plugin.settings;
		if (koreaderMountPoint && (await this.isUsableDir(koreaderMountPoint))) {
			return { isReady: true };
		}

		this.loggingService.warn(
			this.SCOPE,
			"Configured mount point not accessible – attempting auto-detect.",
		);

		for (const candidate of await this.detectCandidates()) {
			if (await this.isUsableDir(candidate)) {
				this.loggingService.info(
					this.SCOPE,
					"Successfully auto-detected mount point:",
					candidate,
				);
				return { isReady: true, autoDetectedPath: candidate };
			}
		}

		this.loggingService.warn(
			this.SCOPE,
			"Failed to find or access any KOReader mount point.",
		);
		return { isReady: false };
	}

	/**
	 * Checks if a path exists and is a directory.
	 * @param p - Path to check
	 * @returns True if path is a usable directory
	 */
	private async isUsableDir(p: string): Promise<boolean> {
		const stats = await this.fs.getNodeStats(p);
		return stats?.isDirectory() ?? false;
	}

	/**
	 * Detects potential KOReader mount points by platform.
	 * Looks for Kobo devices on macOS/Linux and KoboReader.sqlite on Windows.
	 * @returns Array of candidate mount point paths
	 */
	private async detectCandidates(): Promise<string[]> {
		const out: string[] = [];
		if (platform() === "darwin") {
			for await (const e of this.fs.iterateNodeDirectory("/Volumes")) {
				if (e.isDirectory() && e.name.toLowerCase().includes("kobo")) {
					out.push(joinPath("/Volumes", e.name));
				}
			}
		} else if (platform() === "linux") {
			for (const root of ["/media", "/run/media"]) {
				for await (const user of this.fs.iterateNodeDirectory(root)) {
					if (!user.isDirectory()) continue;
					const userPath = joinPath(root, user.name);
					for await (const dev of this.fs.iterateNodeDirectory(userPath)) {
						if (dev.isDirectory() && dev.name.toLowerCase().includes("kobo")) {
							out.push(joinPath(userPath, dev.name));
						}
					}
				}
			}
		} else if (platform() === "win32") {
			for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
				const root = `${letter}:`;
				if (
					await this.fs.nodeFileExists(path.join(root, "KoboReader.sqlite"))
				) {
					out.push(root);
				}
			}
		}
		return out;
	}
}
