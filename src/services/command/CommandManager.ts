import { Notice } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { ScanManager } from "src/services/device/ScanManager";
import type { CacheManager } from "src/utils/cache/CacheManager";
import type { CapabilityManager } from "../CapabilityManager";
import type { SDRFinder } from "../device/SDRFinder";
import { FileSystemService } from "../FileSystemService";
import type { ImportManager } from "../ImportManager";
import type { LoggingService } from "../LoggingService";
import type { LocalIndexService } from "../vault/LocalIndexService";

export class CommandManager {
	private readonly log;

	constructor(
		private readonly plugin: KoreaderImporterPlugin,
		private readonly importManager: ImportManager,
		private readonly scanManager: ScanManager,
		private readonly sdrFinder: SDRFinder,
		private readonly cacheManager: CacheManager,
		private readonly loggingService: LoggingService,
		private readonly localIndexService: LocalIndexService,
		private readonly capabilities: CapabilityManager,
	) {
		this.log = this.loggingService.scoped("CommandManager");
	}

	/**
	 * Ensures the KOReader mount point is available and settings are up-to-date.
	 * @returns The mount point path if successful, otherwise null.
	 */
	private async prepareExecution(): Promise<string | null> {
		const rawMountPoint = await this.sdrFinder.findActiveMountPoint();
		if (!rawMountPoint) {
			this.log.warn("Mount point not available. Aborting command execution.");
			new Notice(
				"KOReader device not found. Please check the mount point in settings.",
			);
			return null;
		}

		const mountPoint = FileSystemService.normalizeSystemPath(rawMountPoint);

		if (mountPoint !== this.plugin.settings.koreaderMountPoint) {
			this.log.info(`Auto-detected new mount point: ${mountPoint}`);
			this.plugin.settings.koreaderMountPoint = mountPoint;
			await this.plugin.saveSettings();
			new Notice(`KOReader: Auto-detected device at "${mountPoint}"`, 5000);
		}

		return mountPoint;
	}

	/**
	 * Executes the highlight import process.
	 * Validates mount point availability before starting import.
	 * Handles cancellation and error reporting.
	 */
	async executeImport(): Promise<void> {
		this.log.info("Import triggered.");

		const mountPoint = await this.prepareExecution();
		if (!mountPoint) {
			return;
		}

		try {
			// Invalidate SDR caches before starting import to ensure fresh scan
			this.sdrFinder.clearCache();
			await this.importManager.importHighlights();
		} catch (error) {
			if ((error as DOMException)?.name === "AbortError") {
				this.log.info("Import was cancelled by the user.");
				new Notice("Import cancelled.");
			} else {
				this.log.error("Import failed with an unexpected error", error);
				new Notice("Import failed. Check console for details.");
			}
		}
	}

	/**
	 * Executes a scan for available highlights without importing.
	 * Shows what files would be processed in an import.
	 */
	async executeScan(): Promise<void> {
		this.log.info("Scan triggered.");

		const mountPoint = await this.prepareExecution();
		if (!mountPoint) {
			return;
		}

		try {
			await this.scanManager.scanForHighlights();
		} catch (error) {
			this.log.error("Scan failed with an unexpected error", error);
			new Notice("Scan failed. Check console for details.");
		}
	}

	/**
	 * Clears all plugin caches.
	 * Useful when encountering issues or after changing settings.
	 */
	async executeClearCaches(): Promise<void> {
		if (!this.cacheManager) {
			this.log.error(
				"CacheManager dependency not available. Cannot clear caches.",
			);
			new Notice(
				"Error: Cache Manager service not ready. Please try reloading the plugin.",
			);
			return;
		}

		this.log.info("Cache clear triggered from plugin.");
		// Clear in-memory caches
		this.cacheManager.clear();
		// Clear SDR-related caches explicitly
		this.sdrFinder.clearCache();
		// Clear per-source skip state in SQLite so next import reprocesses everything
		await this.localIndexService.clearImportSource();
		new Notice("KOReader Importer caches cleared.");
	}

	/**
	 * Performs a full, destructive reset of all plugin indexes and caches.
	 * Deletes persistent files and requests a plugin reload.
	 */
	async executeFullReset(): Promise<void> {
		this.log.warn("Full reset triggered. Deleting all indexes and caches.");

		try {
			// 1) Delete the persistent vault index (SQLite)
			await this.localIndexService.deleteIndexFile();

			// 2) Clear per-source table as additional safeguard (for in-memory)
			try {
				await this.localIndexService.clearImportSource();
			} catch (_) {}

			// 3) Clear any remaining in-memory caches
			this.cacheManager.clear();

			new Notice(
				"KOReader Importer has been reset. Reloading plugin now...",
				5000,
			);

			// 4) Trigger a reload of the plugin for a completely clean state
			// Delay slightly to allow the Notice to be visible
			setTimeout((): void => {
				void this.plugin.reloadPlugin?.();
			}, 1000);
		} catch (error) {
			this.log.error("Full reset failed.", error as Error);
			new Notice(
				"Error during reset. Check the developer console for details.",
				10000,
			);
		}
	}

	/**
	 * Converts all existing highlight files to the current comment style setting.
	 * Rewrites all files to ensure consistency across the highlights folder.
	 */
	async executeConvertCommentStyle(): Promise<void> {
		this.log.info("Comment style conversion triggered.");

		try {
			await this.importManager.convertAllFilesToCommentStyle();
		} catch (error) {
			if ((error as DOMException)?.name === "AbortError") {
				this.log.info("Comment style conversion was cancelled by the user.");
				new Notice("Conversion cancelled.");
			} else {
				this.log.error(
					"Comment style conversion failed with an unexpected error",
					error,
				);
				new Notice("Conversion failed. Check console for details.");
			}
		}
	}

	/**
	 * Forces CapabilityManager to refresh all probes, bypassing TTL/backoff.
	 * Useful when environment changes (e.g., vault remounted read-write).
	 */
	async executeRecheckCapabilities(): Promise<void> {
		try {
			const snap = await this.capabilities.refreshAll(true);
			const msg = `Capabilities: snapshotsWritable=${snap.areSnapshotsWritable ? "ok" : "unavailable"}, indexPersistent=${snap.isPersistentIndexAvailable ? "ok" : "unavailable"}`;
			this.log.info("Capability refresh complete.", snap);
			new Notice(`KOReader Importer: ${msg}`, 5000);
		} catch (e) {
			this.log.error("Capability refresh failed", e);
			new Notice(
				"Failed to re-check capabilities. See console for details.",
				7000,
			);
		}
	}
}
