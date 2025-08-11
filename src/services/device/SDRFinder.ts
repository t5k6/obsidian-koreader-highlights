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
	private readonly log;
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
		this.log = this.loggingService.scoped("SDRFinder");
	}

	/* -------------------------- Public ----------------------------- */

	/**
	 * Provides an async iterator over all metadata.lua file paths.
	 * @yields Full paths to metadata.lua files
	 */
	async *iterSdrDirectories(): AsyncGenerator<string> {
		for (const file of await this.findSdrDirectoriesWithMetadata()) yield file;
	}

	/**
	 * Finds all metadata.lua files under SDR directories.
	 * Results are cached and memoized for performance.
	 * @returns Array of full metadata file paths
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
		const mountPoint = await this.findActiveMountPoint();
		if (!mountPoint) {
			this.log.warn("Cannot read metadata file without an active mount point.");
			return null;
		}

		const name = await this.getMetadataFileName(sdrDir, mountPoint);
		if (!name) return null;

		const fullPath = joinPath(sdrDir, name);
		try {
			this.log.info("Reading metadata:", fullPath);
			return await this.fs.readNodeFile(fullPath);
		} catch (err) {
			this.log.error(`Failed to read metadata file: ${fullPath}`, err);
			return null;
		}
	}

	public onSettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
	): void {
		const prevKey = this.cacheKey;
		this.updateCacheKey(newSettings);
		if (this.cacheKey !== prevKey) {
			this.cacheManager.clear("sdr.*");
			this.log.info("Settings changed, SDR caches cleared.");
		}
	}

	/**
	 * Explicitly clears SDR-related caches.
	 * Useful to force a fresh device scan within the same session.
	 */
	public clearCache(): void {
		this.cacheManager.clear("sdr.*");
		this.log.info("SDRFinder caches have been cleared.");
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

		const mountPoint = await this.findActiveMountPoint();
		if (!mountPoint) {
			return [];
		}

		const { excludedFolders } = this.plugin.settings;
		const root = mountPoint;
		const excluded = new Set(
			excludedFolders.map((e) => e.trim().toLowerCase()),
		);

		const results: string[] = [];
		await this.walk(root, excluded, results, mountPoint);
		this.log.info(`Scan finished. Found ${results.length} metadata files.`);
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
		mountPoint: string,
	): Promise<void> {
		for await (const entry of this.fs.iterateNodeDirectory(dir)) {
			if (!entry.isDirectory()) continue;
			if (excluded.has(entry.name.toLowerCase())) continue;

			const fullPath = joinPath(dir, entry.name);

			if (entry.name.endsWith(SDR_SUFFIX)) {
				const metadataFileName = await this.getMetadataFileName(
					fullPath,
					mountPoint,
				);
				if (metadataFileName) {
					// push the full path to the metadata file
					out.push(joinPath(fullPath, metadataFileName));
				}
			} else if (!entry.name.startsWith(".") && entry.name !== "$RECYCLE.BIN") {
				await io(() => this.walk(fullPath, excluded, out, mountPoint));
			}
		}
	}

	/**
	 * Finds the metadata filename in an SDR directory.
	 * Respects allowed file type settings.
	 * @param dir - SDR directory path
	 * @returns Metadata filename or null if not found
	 */
	private async getMetadataFileName(
		dir: string,
		mountPoint: string,
	): Promise<string | null> {
		const cacheKey = `${mountPoint}::${dir}`;
		const cached = this.metadataNameCache.get(cacheKey);
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
					this.metadataNameCache.set(cacheKey, entry.name);
					return entry.name;
				}
			}
		}

		this.metadataNameCache.set(cacheKey, null);
		return null;
	}

	/* ---------- mount-point handling / auto-detect ----------------- */

	public async findActiveMountPoint(): Promise<string | null> {
		const { koreaderMountPoint } = this.plugin.settings;
		if (koreaderMountPoint && (await this.isUsableDir(koreaderMountPoint))) {
			return koreaderMountPoint;
		}

		for (const candidate of await this.detectCandidates()) {
			if (await this.isUsableDir(candidate)) {
				this.log.info("Auto-detected a usable mount point:", candidate);
				return candidate;
			}
		}

		// Return null if no configured or auto-detected path is found.
		return null;
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
		const os = platform();

		if (os === "darwin") {
			for (const p of await this.listDirs("/Volumes")) {
				if (path.basename(p).toLowerCase().includes("kobo")) out.push(p);
			}
		} else if (os === "linux") {
			for (const root of ["/media", "/run/media"]) {
				for (const userDir of await this.listDirs(root)) {
					for (const deviceDir of await this.listDirs(userDir)) {
						if (path.basename(deviceDir).toLowerCase().includes("kobo")) {
							out.push(deviceDir);
						}
					}
				}
			}
		} else if (platform() === "win32") {
			for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
				const root = `${letter}:\\`;
				if (
					await this.fs.nodeFileExists(path.join(root, "KoboReader.sqlite"))
				) {
					out.push(root);
				}
			}
		}
		return out;
	}

	private async listDirs(parentPath: string): Promise<string[]> {
		const subdirs: string[] = [];
		try {
			for await (const entry of this.fs.iterateNodeDirectory(parentPath)) {
				if (entry.isDirectory()) subdirs.push(joinPath(parentPath, entry.name));
			}
		} catch {
			// iterateNodeDirectory already logs/filters common errors
		}
		return subdirs;
	}
}
