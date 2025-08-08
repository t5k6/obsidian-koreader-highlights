import { Notice } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { ScanManager } from "src/services/device/ScanManager";
import type { CacheManager } from "src/utils/cache/CacheManager";
import type { SDRFinder } from "../device/SDRFinder";
import { FileSystemService } from "../FileSystemService";
import type { ImportManager } from "../ImportManager";
import type { LoggingService } from "../LoggingService";
import type ImportIndexService from "../vault/ImportIndexService";
import type { LocalIndexService } from "../vault/LocalIndexService";

export class CommandManager {
	private readonly SCOPE = "CommandManager";

	constructor(
		private readonly plugin: KoreaderImporterPlugin,
		private readonly importManager: ImportManager,
		private readonly scanManager: ScanManager,
		private readonly sdrFinder: SDRFinder,
		private readonly cacheManager: CacheManager,
		private readonly loggingService: LoggingService,
		private readonly importIndexService: ImportIndexService,
		private readonly localIndexService: LocalIndexService,
	) {}

	/**
	 * Ensures the KOReader mount point is available and settings are up-to-date.
	 * @returns The mount point path if successful, otherwise null.
	 */
	private async prepareExecution(): Promise<string | null> {
		const rawMountPoint = await this.sdrFinder.findActiveMountPoint();
		if (!rawMountPoint) {
			this.loggingService.warn(
				this.SCOPE,
				"Mount point not available. Aborting command execution.",
			);
			new Notice(
				"KOReader device not found. Please check the mount point in settings.",
			);
			return null;
		}

		const mountPoint = FileSystemService.normalizeSystemPath(rawMountPoint);

		if (mountPoint !== this.plugin.settings.koreaderMountPoint) {
			this.loggingService.info(
				this.SCOPE,
				`Auto-detected new mount point: ${mountPoint}`,
			);
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
		this.loggingService.info(this.SCOPE, "Import triggered.");

		const mountPoint = await this.prepareExecution();
		if (!mountPoint) {
			return;
		}

		try {
			// Invalidate SDR caches before starting import to ensure fresh scan
			if (typeof (this.sdrFinder as any).clearCache === "function") {
				(this.sdrFinder as any).clearCache();
			}
			await this.importManager.importHighlights();
		} catch (error) {
			if ((error as DOMException)?.name === "AbortError") {
				this.loggingService.info(
					this.SCOPE,
					"Import was cancelled by the user.",
				);
				new Notice("Import cancelled.");
			} else {
				this.loggingService.error(
					this.SCOPE,
					"Import failed with an unexpected error",
					error,
				);
				new Notice("Import failed. Check console for details.");
			}
		}
	}

	/**
	 * Executes a scan for available highlights without importing.
	 * Shows what files would be processed in an import.
	 */
	async executeScan(): Promise<void> {
		this.loggingService.info(this.SCOPE, "Scan triggered.");

		const mountPoint = await this.prepareExecution();
		if (!mountPoint) {
			return;
		}

		try {
			await this.scanManager.scanForHighlights();
		} catch (error) {
			this.loggingService.error(
				this.SCOPE,
				"Scan failed with an unexpected error",
				error,
			);
			new Notice("Scan failed. Check console for details.");
		}
	}

	/**
	 * Clears all plugin caches.
	 * Useful when encountering issues or after changing settings.
	 */
	async executeClearCaches(): Promise<void> {
		if (!this.cacheManager) {
			this.loggingService.error(
				this.SCOPE,
				"CacheManager dependency not available. Cannot clear caches.",
			);
			new Notice(
				"Error: Cache Manager service not ready. Please try reloading the plugin.",
			);
			return;
		}

		this.loggingService.info(this.SCOPE, "Cache clear triggered from plugin.");
		// Clear in-memory caches
		this.cacheManager.clear();
		// Clear SDR-related caches explicitly
		if (typeof (this.sdrFinder as any).clearCache === "function") {
			(this.sdrFinder as any).clearCache();
		} else {
			// Fallback: retrigger settings change to invalidate
			this.sdrFinder.onSettingsChanged(this.plugin.settings);
		}
		// Clear persistent import index so next import reprocesses everything
		this.importIndexService.clear();
		await this.importIndexService.save();
		new Notice("KOReader Importer caches cleared.");
	}

	/**
	 * Performs a full, destructive reset of all plugin indexes and caches.
	 * Deletes persistent files and requests a plugin reload.
	 */
	async executeFullReset(): Promise<void> {
		this.loggingService.warn(
			this.SCOPE,
			"Full reset triggered. Deleting all indexes and caches.",
		);

		try {
			// 1) Delete the persistent vault index (SQLite)
			await this.localIndexService.deleteIndexFile();

			// 2) Delete the persistent import index (JSON)
			await this.importIndexService.deleteIndexFile();

			// 3) Clear any remaining in-memory caches
			this.cacheManager.clear();

			new Notice(
				"KOReader Importer has been reset. Reloading plugin now...",
				5000,
			);

			// 4) Trigger a reload of the plugin for a completely clean state
			// Delay slightly to allow the Notice to be visible
			setTimeout(() => {
				void (this.plugin as any).reloadPlugin?.();
			}, 1000);
		} catch (error) {
			this.loggingService.error(
				this.SCOPE,
				"Full reset failed.",
				error as Error,
			);
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
		this.loggingService.info(this.SCOPE, "Comment style conversion triggered.");

		try {
			await this.importManager.convertAllFilesToCommentStyle();
		} catch (error) {
			if ((error as DOMException)?.name === "AbortError") {
				this.loggingService.info(
					this.SCOPE,
					"Comment style conversion was cancelled by the user.",
				);
				new Notice("Conversion cancelled.");
			} else {
				this.loggingService.error(
					this.SCOPE,
					"Comment style conversion failed with an unexpected error",
					error,
				);
				new Notice("Conversion failed. Check console for details.");
			}
		}
	}
}
