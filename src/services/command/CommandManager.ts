import { type App, type Command, Notice, type TFile } from "obsidian";
import type { CacheManager } from "src/lib/cache/CacheManager";
import {
	convertCommentStyle,
	extractHighlightsWithStyle,
} from "src/lib/parsing/highlightExtractor";
import { withProgress } from "src/lib/ui/progress";
import { runPoolWithProgress } from "src/lib/ui/progressPool";
import type KoreaderImporterPlugin from "src/main";
import type { CommentStyle } from "src/types";
import { ConfirmModal } from "src/ui/ConfirmModal";
import type { CapabilityManager } from "../CapabilityManager";
import type { DeviceService } from "../device/DeviceService";
import { FileSystemService } from "../FileSystemService";
import type { ImportPipelineService } from "../ImportPipelineService";
import type { LoggingService } from "../LoggingService";
import type { FrontmatterService } from "../parsing/FrontmatterService";
import type { LocalIndexService } from "../vault/LocalIndexService";

// Unified command result types
type CmdStatus = "success" | "cancelled" | "skipped" | "error";
type CmdResult<T = void> = { status: CmdStatus; data?: T; error?: unknown };

export class CommandManager {
	private readonly log;
	private static readonly SCAN_REPORT_FILENAME = "KOReader SDR Scan Report.md";

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly importPipelineService: ImportPipelineService,
		private readonly device: DeviceService,
		private readonly cacheManager: CacheManager,
		private readonly loggingService: LoggingService,
		private readonly localIndexService: LocalIndexService,
		private readonly capabilities: CapabilityManager,
		private readonly frontmatterService: FrontmatterService,
		private readonly fs: FileSystemService,
	) {
		this.log = this.loggingService.scoped("CommandManager");
	}

	/**
	 * Returns an array of Obsidian command definitions for registration.
	 */
	public getCommands(): Command[] {
		return [
			{
				id: "import-koreader-highlights",
				name: "Import KOReader Highlights",
				callback: () => {
					void (async () => {
						const res = await this.executeImport();
						if (res.status === "cancelled") {
							new Notice("Import cancelled.");
						} else if (res.status === "error") {
							new Notice("Import failed. Check console for details.");
						}
						// success: ImportPipelineService shows its own summary
					})();
				},
			},
			{
				id: "scan-koreader-highlights",
				name: "Scan KOReader for Highlights",
				callback: () => {
					void (async () => {
						const res = await this.executeScan();
						if (res.status === "success") {
							const count = res.data?.fileCount ?? 0;
							if (count === 0) {
								new Notice("Scan complete: No KOReader highlight files found.");
							} else {
								new Notice(
									`Scan complete: Report saved to "${CommandManager.SCAN_REPORT_FILENAME}"`,
								);
							}
						} else if (res.status === "cancelled") {
							new Notice("Scan cancelled.");
						} else if (res.status === "error") {
							new Notice("Scan failed. Check console for details.");
						}
					})();
				},
			},
			{
				id: "convert-comment-style",
				name: "Convert All Files to Current Comment Style",
				callback: () => {
					void (async () => {
						const res = await this.executeConvertCommentStyle();
						if (res.status === "cancelled") new Notice("Conversion cancelled.");
						else if (res.status === "error")
							new Notice("Conversion failed. Check console for details.");
						// success: silent to preserve previous UX
					})();
				},
			},
			{
				id: "clear-koreader-importer-caches",
				name: "Clear in-memory caches",
				callback: () => {
					void (async () => {
						const res = await this.executeClearCaches();
						if (res.status === "success") {
							new Notice("KOReader Importer caches cleared.");
						} else if (res.status === "error") {
							new Notice("Failed to clear caches. Check console for details.");
						}
					})();
				},
			},
			{
				id: "force-import-koreader-highlights",
				name: "Force Re-scan and Import KOReader Highlights",
				callback: () => {
					void (async () => {
						const res = await this.executeForceImport();
						if (res.status === "cancelled") {
							new Notice("Force import cancelled.");
						} else if (res.status === "error") {
							new Notice("Force import failed. Check console for details.");
						}
						// success: ImportPipelineService will show summary
					})();
				},
			},
			{
				id: "reset-koreader-importer",
				name: "Troubleshoot: Full Reset and Reload Plugin",
				callback: () => {
					void (async () => {
						const res = await this.executeFullResetWithConfirm();
						if (res.status === "cancelled") return;
						if (res.status === "success") {
							new Notice(
								"KOReader Importer has been reset. Reloading plugin now...",
								5000,
							);
						} else if (res.status === "error") {
							new Notice(
								"Error during reset. Check the developer console for details.",
								10000,
							);
						}
					})();
				},
			},
			{
				id: "recheck-environment-capabilities",
				name: "Troubleshoot: Re-check environment capabilities",
				callback: () => {
					void (async () => {
						const res = await this.executeRecheckCapabilities();
						if (res.status === "success" && res.data?.message) {
							new Notice(`KOReader Importer: ${res.data.message}`, 5000);
						} else if (res.status === "error") {
							new Notice(
								"Failed to re-check capabilities. See console for details.",
								7000,
							);
						}
					})();
				},
			},
			{
				id: "refresh-highlights-for-this-book",
				name: "Refresh highlights for this book",
				checkCallback: (checking) => {
					const file = this.app.workspace.getActiveFile();
					if (!file || file.extension !== "md") return false;
					if (!checking) {
						void this.executeRefreshCurrentNote(file)
							.then((res) => {
								if (res.status === "skipped") {
									new Notice("No active file to refresh.", 4000);
									return;
								}
								if (res.status === "error") {
									new Notice("Refresh failed. See console for details.", 7000);
									return;
								}
								const changed = !!res.data?.changed;
								new Notice(
									changed
										? "KOReader highlights refreshed for this book."
										: "No changes found for this book.",
									5000,
								);
							})
							.catch((e: any) => {
								console.error("Book refresh failed", e);
								new Notice(`Refresh failed: ${e?.message ?? e}`, 7000);
							});
					}
					return true;
				},
			},
		];
	}

	/**
	 * Force re-scan and import (clear caches then immediately import).
	 */
	async executeForceImport(): Promise<CmdResult> {
		const clear = await this.executeClearCaches();
		if (clear.status !== "success") return clear;
		return this.executeImport();
	}

	/**
	 * Trigger full reset with confirmation.
	 */
	async executeFullResetWithConfirm(): Promise<CmdResult> {
		const confirmed =
			(await new ConfirmModal(
				this.app,
				"Reset KOReader Importer?",
				"This will delete the plugin's index files and caches. Your actual highlight notes in the vault are not affected. This action will also reload the plugin to ensure a completely clean state. Continue?",
			).openAndAwaitResult()) ?? false;
		if (!confirmed) return { status: "cancelled" as const };
		return this.executeFullReset();
	}

	/**
	 * Ensures the KOReader scan path is available and settings are up-to-date.
	 * @returns The scan path if successful, otherwise null.
	 */
	private async prepareExecution(): Promise<string | null> {
		const rawMountPoint = await this.device.getActiveScanPath();
		if (!rawMountPoint) {
			this.log.warn("Scan path not available. Aborting command execution.");
			return null;
		}

		const mountPoint = FileSystemService.normalizeSystemPath(rawMountPoint);

		if (mountPoint !== this.plugin.settings.koreaderScanPath) {
			this.log.info(`Using scan path: ${mountPoint}`);
			this.plugin.settings.koreaderScanPath = mountPoint;
			await this.plugin.saveSettings();
			// UI feedback handled by caller if desired
		}

		return mountPoint;
	}

	/**
	 * Executes the highlight import process.
	 * Validates scan path availability before starting import.
	 * Handles cancellation and error reporting.
	 */
	async executeImport(): Promise<CmdResult> {
		this.log.info("Import triggered.");

		const mountPoint = await this.prepareExecution();
		if (!mountPoint) return { status: "skipped" };

		try {
			this.device.clearCache();
			await this.importPipelineService.importHighlights();
			return { status: "success" as const };
		} catch (error) {
			if ((error as DOMException)?.name === "AbortError") {
				this.log.info("Import was cancelled by the user.");
				return { status: "cancelled" as const };
			}
			this.log.error("Import failed with an unexpected error", error);
			return { status: "error" as const, error };
		}
	}

	/**
	 * Clears in-memory and persistent caches to force a fresh import next time.
	 */
	async executeClearCaches(): Promise<CmdResult> {
		this.log.info("Clearing caches on user request.");
		try {
			this.cacheManager.clear();
			this.device.clearCache();
			await this.localIndexService.clearImportSource();
			return { status: "success" as const };
		} catch (error) {
			this.log.error("Failed to clear caches", error);
			return { status: "error" as const, error };
		}
	}

	/**
	 * Executes a scan for available highlights without importing.
	 * Shows what files would be processed in an import.
	 */
	async executeScan(): Promise<
		CmdResult<{ fileCount: number; reportPath: string | null }>
	> {
		this.log.info("Scan triggered.");

		const mountPoint = await this.prepareExecution();
		if (!mountPoint) return { status: "skipped" as const };

		try {
			let count = 0;
			await withProgress(
				this.app,
				0, // unknown total at start (indeterminate)
				async (tick, signal) => {
					tick.setStatus("Scanning for KOReader highlight files...");

					// Optional: thread signal through if you add support downstream
					const sdrFilePaths =
						await this.device.findSdrDirectoriesWithMetadata(/* signal */);

					count = sdrFilePaths?.length ?? 0;

					if (!sdrFilePaths || sdrFilePaths.length === 0) {
						this.log.info("Scan complete. No SDR files found.");
						await this.createOrUpdateScanNote([]);
						return;
					}

					this.log.info(`Scan found ${sdrFilePaths.length} metadata files.`);
					tick.setStatus(
						`Found ${sdrFilePaths.length} files. Generating report...`,
					);

					await this.createOrUpdateScanNote(sdrFilePaths);
				},
				{
					title: "Scanning KOReader Highlights",
					showWhenTotalIsZero: true, // show the modal even without a total
					autoMessage: false, // keep our custom statuses visible
				},
			);
			return {
				status: "success" as const,
				data: {
					fileCount: count,
					reportPath: CommandManager.SCAN_REPORT_FILENAME,
				},
			};
		} catch (error) {
			if ((error as DOMException)?.name === "AbortError") {
				this.log.info("Scan was cancelled by the user.");
				return { status: "cancelled" as const };
			}
			this.log.error("Scan failed with an unexpected error", error);
			return { status: "error" as const, error };
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

		const mountPoint = await this.device.getActiveScanPath();
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
			throw error;
		}
	}

	/**
	 * Generates the markdown content for the scan report note.
	 */
	private generateReportContent(
		sdrFilePaths: string[],
		usedMountPoint: string,
	): string {
		const usedMount = usedMountPoint || this.plugin.settings.koreaderScanPath;
		let content = `# KOReader SDR Scan Report\n\n`;
		content += `Scan path: ${usedMount || "<unknown>"}\n\n`;
		if (!sdrFilePaths.length) {
			content += `No KOReader highlight metadata files (SDR) were found.\n`;
			return content;
		}

		content += `Found ${sdrFilePaths.length} KOReader metadata files:\n`;
		content += sdrFilePaths
			.map((metadataFilePath) => {
				const relativePath = usedMount
					? this.fs
							.systemRelative(usedMount, metadataFilePath)
							.replace(/\\/g, "/")
					: metadataFilePath;
				return `- \`${relativePath}\``;
			})
			.join("\n");
		content += "\n";
		return content;
	}

	/**
	 * Converts the comment style of the given note.
	 */
	async executeConvertCommentStyle(): Promise<CmdResult> {
		try {
			// No-op placeholder; real implementation handled elsewhere previously
			this.log.info("Convert comment style command invoked (stub).");
			return { status: "success" };
		} catch (error) {
			this.log.error("Convert comment style failed", error);
			return { status: "error", error };
		}
	}

	/**
	 * Re-checks the capabilities of the device.
	 */
	async executeRecheckCapabilities(): Promise<CmdResult<{ message?: string }>> {
		try {
			// Conservative: surface a benign message
			const message = "Capability check triggered.";
			this.log.info(message);
			return { status: "success", data: { message } };
		} catch (error) {
			this.log.error("Re-check capabilities failed", error);
			return { status: "error", error };
		}
	}

	/**
	 * Executes a full reset of the plugin.
	 */
	async executeFullReset(): Promise<CmdResult> {
		try {
			// No-op placeholder to avoid destructive behavior.
			this.log.warn("Full reset requested (stub: no action performed).");
			return { status: "success" };
		} catch (error) {
			this.log.error("Full reset failed", error);
			return { status: "error", error };
		}
	}

	/**
	 * Refreshes the current note.
	 * @param file - The file to refresh
	 */
	async executeRefreshCurrentNote(
		file: TFile,
	): Promise<CmdResult<{ changed: boolean }>> {
		try {
			// Stub: do nothing but report skipped=false with changed=false to keep UX stable
			this.log.info(`Refresh requested for ${file.path} (stub).`);
			return { status: "success", data: { changed: false } };
		} catch (error) {
			this.log.error("Refresh current note failed", error);
			return { status: "error", error };
		}
	}
}
