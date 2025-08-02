import { Notice } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { ScanManager } from "src/services/device/ScanManager";
import type { CacheManager } from "src/utils/cache/CacheManager";
import type { SDRFinder } from "../device/SDRFinder";
import { FileSystemService } from "../FileSystemService";
import type { ImportManager } from "../ImportManager";
import type { LoggingService } from "../LoggingService";

export class CommandManager {
	private readonly SCOPE = "CommandManager";

	constructor(
		private readonly plugin: KoreaderImporterPlugin,
		private readonly importManager: ImportManager,
		private readonly scanManager: ScanManager,
		private readonly sdrFinder: SDRFinder,
		private readonly cacheManager: CacheManager,
		private readonly loggingService: LoggingService,
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
		this.loggingService.info(this.SCOPE, "Cache clear triggered from plugin.");
		this.cacheManager.clear();
		new Notice("KOReader Importer caches cleared.");
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
