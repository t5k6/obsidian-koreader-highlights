import path from "node:path";
import { type App, Notice } from "obsidian";
import type { CacheManager } from "src/lib/cache/CacheManager";
import type KoreaderImporterPlugin from "src/main";
import { ProgressModal } from "src/ui/ProgressModal";
import type { CapabilityManager } from "../CapabilityManager";
import type { KoreaderEnvironmentService } from "../device/KoreaderEnvironmentService";
import type { SDRFinder } from "../device/SDRFinder";
import { FileSystemService } from "../FileSystemService";
import type { ImportPipelineService } from "../ImportPipelineService";
import type { LoggingService } from "../LoggingService";
import type { LocalIndexService } from "../vault/LocalIndexService";
import type { NoteMaintenanceService } from "../vault/NoteMaintenanceService";

export class CommandManager {
	private readonly log;
	private static readonly SCAN_REPORT_FILENAME = "KOReader SDR Scan Report.md";

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly importPipelineService: ImportPipelineService,
		private readonly sdrFinder: SDRFinder,
		private readonly envService: KoreaderEnvironmentService,
		private readonly cacheManager: CacheManager,
		private readonly loggingService: LoggingService,
		private readonly localIndexService: LocalIndexService,
		private readonly capabilities: CapabilityManager,
		private readonly noteMaintenance: NoteMaintenanceService,
		private readonly fs: FileSystemService,
	) {
		this.log = this.loggingService.scoped("CommandManager");
	}

	/**
	 * Ensures the KOReader scan path is available and settings are up-to-date.
	 * @returns The scan path if successful, otherwise null.
	 */
	private async prepareExecution(): Promise<string | null> {
		const rawMountPoint = await this.envService.getActiveScanPath();
		if (!rawMountPoint) {
			this.log.warn("Scan path not available. Aborting command execution.");
			new Notice(
				"KOReader device not found. Please check the scan path in settings.",
			);
			return null;
		}

		const mountPoint = FileSystemService.normalizeSystemPath(rawMountPoint);

		if (mountPoint !== this.plugin.settings.koreaderScanPath) {
			this.log.info(`Using scan path: ${mountPoint}`);
			this.plugin.settings.koreaderScanPath = mountPoint;
			await this.plugin.saveSettings();
			new Notice(`KOReader: Using scan path "${mountPoint}"`, 5000);
		}

		return mountPoint;
	}

	/**
	 * Executes the highlight import process.
	 * Validates scan path availability before starting import.
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
			await this.importPipelineService.importHighlights();
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
	 * Clears in-memory and persistent caches to force a fresh import next time.
	 */
	async executeClearCaches(): Promise<void> {
		this.log.info("Clearing caches on user request.");
		// Clear in-memory caches
		this.cacheManager.clear();
		// Clear SDR-related caches explicitly
		this.sdrFinder.clearCache();
		// Clear per-source skip state in SQLite so next import reprocesses everything
		await this.localIndexService.clearImportSource();
		new Notice("KOReader Importer caches cleared.");
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

		const modal = new ProgressModal(this.app, "Scanning KOReader Highlights");
		try {
			modal.open();
			modal.statusEl.setText("Scanning for KOReader highlight files...");

			const sdrFilePaths =
				await this.sdrFinder.findSdrDirectoriesWithMetadata();

			if (!sdrFilePaths || sdrFilePaths.length === 0) {
				this.log.info("Scan complete. No SDR files found.");
				await this.createOrUpdateScanNote([]);
				new Notice("Scan complete: No KOReader highlight files found.");
				return;
			}

			this.log.info(`Scan found ${sdrFilePaths.length} metadata files.`);
			modal.statusEl.setText(
				`Found ${sdrFilePaths.length} files. Generating report...`,
			);

			await this.createOrUpdateScanNote(sdrFilePaths);

			new Notice(
				`Scan complete: Report saved to "${CommandManager.SCAN_REPORT_FILENAME}"`,
			);
		} catch (error) {
			this.log.error("Scan failed with an unexpected error", error);
			new Notice("Scan failed. Check console for details.");
		} finally {
			modal.close();
		}
	}

	/**
	 * Creates or updates the scan report file in the vault.
	 * @param sdrFilePaths - Array of metadata file paths found
	 */
	private async createOrUpdateScanNote(sdrFilePaths: string[]): Promise<void> {
		const reportFilename = CommandManager.SCAN_REPORT_FILENAME;
		const reportFolderPath = this.plugin.settings.highlightsFolder;
		const fullReportPath = `${reportFolderPath}/${reportFilename}`;

		const mountPoint = await this.envService.getActiveScanPath();
		const reportContent = this.generateReportContent(
			sdrFilePaths,
			mountPoint ?? "",
		);

		try {
			this.log.info(`Creating or updating scan report: ${fullReportPath}`);
			await this.fs.writeVaultFile(fullReportPath, reportContent);
		} catch (error) {
			this.log.error(
				`Error creating/updating scan report note at ${fullReportPath}:`,
				error,
			);
			new Notice("Failed to save scan report note.");
		}
	}

	/**
	 * Generates the markdown content for the scan report.
	 */
	private generateReportContent(
		sdrFilePaths: string[],
		usedMountPoint: string,
	): string {
		const timestamp = new Date().toLocaleString();
		let content = "# KOReader SDR Scan Report\n\n";
		content += `*Scan performed on: ${timestamp}*\n`;
		const mountPointDisplay =
			usedMountPoint || this.plugin.settings.koreaderScanPath;
		content += `*Scan Path: ${mountPointDisplay}*\n\n`;

		if (sdrFilePaths.length === 0) {
			content +=
				"No `.sdr` metadata files (`metadata.*.lua`) were found matching the current settings.\n";
		} else {
			content += `Found ${sdrFilePaths.length} metadata files:\n\n`;
			content += sdrFilePaths
				.map((metadataFilePath) => {
					const relativePath = usedMountPoint
						? path
								.relative(usedMountPoint, metadataFilePath)
								.replace(/\\/g, "/")
						: metadataFilePath;
					return `- \`${relativePath}\``;
				})
				.join("\n");
		}

		content += "\n\n---\n";
		content += "**Settings Used:**\n";
		content += `- Excluded Folders: \`${
			this.plugin.settings.excludedFolders.join(", ") || "(None)"
		}\`\n`;
		content += `- Allowed File Types: \`${
			this.plugin.settings.allowedFileTypes.join(", ") || "(All)"
		}\`\n`;

		return content;
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
			await this.noteMaintenance.convertAllFilesToCommentStyle();
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
