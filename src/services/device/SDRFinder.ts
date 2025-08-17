import { join as joinPath } from "node:path";
import pLimit from "p-limit";
import { type CacheManager, memoizeAsync } from "src/lib/cache/CacheManager";
import { isErr } from "src/lib/core/result";
import type KoreaderImporterPlugin from "src/main";
import type {
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { KoreaderEnvironmentService } from "./KoreaderEnvironmentService";

/* ------------------------------------------------------------------ */
/*                              CONSTS                                */
/* ------------------------------------------------------------------ */

const SDR_SUFFIX = ".sdr";
const METADATA_REGEX = /^metadata\.(.+)\.lua$/i;
const MAX_PARALLEL_IO = 32;

/* ------------------------------------------------------------------ */
/*                            MAIN CLASS                              */
/* ------------------------------------------------------------------ */

export class SDRFinder implements SettingsObserver {
	private readonly log;
	private readonly limit = pLimit(MAX_PARALLEL_IO);
	private sdrDirCache: Map<string, Promise<string[]>>;
	private metadataNameCache: Map<string, string | null>;
	private findSdrDirectoriesWithMetadataMemoized: (
		scanPath: string,
	) => Promise<string[]>;

	constructor(
		private plugin: KoreaderImporterPlugin,
		private cacheManager: CacheManager,
		private fs: FileSystemService,
		private loggingService: LoggingService,
		private envService: KoreaderEnvironmentService,
	) {
		this.sdrDirCache = cacheManager.createMap("sdr.dirPromise");
		this.metadataNameCache = cacheManager.createMap("sdr.metaName");

		this.findSdrDirectoriesWithMetadataMemoized = memoizeAsync(
			this.sdrDirCache,
			(scanPath: string) => this.scan(scanPath),
		);
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
		const scanPath = await this.envService.getActiveScanPath();
		if (!scanPath) return [];
		return this.findSdrDirectoriesWithMetadataMemoized(scanPath);
	}

	/**
	 * Reads the content of a metadata.lua file from an SDR directory.
	 * @param sdrDir - Path to the SDR directory
	 * @returns File content as string or null if not found/readable
	 */
	async readMetadataFileContent(sdrDir: string): Promise<string | null> {
		const mountPoint = await this.envService.getActiveScanPath();
		if (!mountPoint) {
			this.log.warn("Cannot read metadata file without an active mount point.");
			return null;
		}

		const name = await this.getMetadataFileName(sdrDir, mountPoint);
		if (!name) return null;

		const fullPath = joinPath(sdrDir, name);
		this.log.info("Reading metadata:", fullPath);
		const res = await this.fs.readNodeFile(fullPath, false);
		if (isErr(res)) {
			this.log.error(
				`Failed to read metadata file: ${fullPath}`,
				(res as any).error ?? res,
			);
			return null;
		}
		const v = res.value;
		return typeof v === "string" ? v : new TextDecoder().decode(v);
	}

	public onSettingsChanged(
		_newSettings: KoreaderHighlightImporterSettings,
	): void {
		this.cacheManager.clear("sdr.*");
		this.log.info("Settings changed, SDR caches cleared.");
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

	// cache key derived directly from scanPath; no additional key management needed

	/**
	 * Performs the actual filesystem scan for SDR directories.
	 * @param cacheKey - Cache key to validate scan currency
	 * @returns Array of valid SDR directory paths
	 */
	private async scan(scanPath: string): Promise<string[]> {
		const mountPoint = scanPath;

		const { excludedFolders } = this.plugin.settings;
		const root = mountPoint;
		const excluded = new Set<string>(
			excludedFolders.map((e: string) => e.trim().toLowerCase()),
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
		const subdirTasks: Promise<void>[] = [];

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
				subdirTasks.push(
					this.limit(() => this.walk(fullPath, excluded, out, mountPoint)),
				);
			}
		}

		if (subdirTasks.length) {
			await Promise.all(subdirTasks);
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
		const allow = new Set<string>(
			allowedFileTypes
				.map((t: string) => t.trim().toLowerCase())
				.filter(Boolean),
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
}
