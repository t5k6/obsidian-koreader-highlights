import { Notice } from "obsidian";
import { runPluginAction } from "src/utils/actionUtils";
import type { CacheManager } from "src/utils/cache/CacheManager";
import { logger } from "src/utils/logging";
import type { ImportManager } from "./ImportManager";
import type { MountPointService } from "./MountPointService";
import type { ScanManager } from "./ScanManager";

export class CommandManager {
	constructor(
		private readonly importManager: ImportManager,
		private readonly scanManager: ScanManager,
		private readonly mountPointService: MountPointService,
		private readonly cacheManager: CacheManager,
	) {}

	/**
	 * Executes the highlight import process.
	 * Validates mount point availability before starting import.
	 * Handles cancellation and error reporting.
	 */
	async executeImport(): Promise<void> {
		logger.info("CommandManager: Import triggered.");

		if (!(await this.mountPointService.ensureMountPoint())) {
			new Notice(
				"KOReader device not found. Please check the mount point in settings.",
			);
			return;
		}

		await runPluginAction(() => this.importManager.importHighlights(), {
			failureNotice: "An unexpected error occurred during import",
		}).catch((error) => {
			if (error.name === "AbortError") {
				// user cancellation
				logger.info("CommandManager: Import was cancelled by the user.");
			} else {
				logger.error(
					"CommandManager: Import failed with an unexpected error",
					error,
				);
				new Notice("Import failed. Check console for details.");
			}
		});
	}

	/**
	 * Executes a scan for available highlights without importing.
	 * Shows what files would be processed in an import.
	 */
	async executeScan(): Promise<void> {
		logger.info("CommandManager: Scan triggered.");

		if (!(await this.mountPointService.ensureMountPoint())) {
			new Notice(
				"KOReader device not found. Please check the mount point in settings.",
			);
			return;
		}

		await runPluginAction(() => this.scanManager.scanForHighlights(), {
			failureNotice: "An unexpected error occurred during scan",
		});
	}

	/**
	 * Clears all plugin caches.
	 * Useful when encountering issues or after changing settings.
	 */
	async executeClearCaches(): Promise<void> {
		logger.info("CommandManager: Cache clear triggered from plugin.");

		await runPluginAction(() => Promise.resolve(this.cacheManager.clear()), {
			successNotice: "KOReader Importer caches cleared.",
			failureNotice: "Failed to clear caches",
		});
	}
}
