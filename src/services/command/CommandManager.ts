import path from "node:path";
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
	async executeFullReset(): Promise<CmdResult> {
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

			// 4) Trigger a reload of the plugin for a completely clean state
			// Delay slightly to allow the Notice to be visible
			setTimeout((): void => {
				void this.plugin.reloadPlugin?.();
			}, 1000);
			return { status: "success" as const };
		} catch (error) {
			this.log.error("Full reset failed.", error as Error);
			return { status: "error" as const, error };
		}
	}

	/**
	 * Converts all existing highlight files to the current comment style setting.
	 * Rewrites all files to ensure consistency across the highlights folder.
	 */
	async executeConvertCommentStyle(): Promise<CmdResult> {
		this.log.info("Comment style conversion triggered.");

		try {
			await this.convertAllFilesToCommentStyleInternal();
			return { status: "success" as const };
		} catch (error) {
			if ((error as DOMException)?.name === "AbortError") {
				this.log.info("Comment style conversion was cancelled by the user.");
				return { status: "cancelled" as const };
			}
			this.log.error(
				"Comment style conversion failed with an unexpected error",
				error,
			);
			return { status: "error" as const, error };
		}
	}

	// --- Inlined from NoteMaintenanceService ---
	private async convertAllFilesToCommentStyleInternal(): Promise<void> {
		this.log.info("Starting comment style conversion for all highlight files…");

		const targetStyle = this.plugin.settings.commentStyle;
		await this.checkIfConvertingFromNoneInternal(targetStyle);

		const files = await this.getHighlightFilesToConvertInternal();
		if (!files) return;

		const results = await runPoolWithProgress(this.app, files, {
			maxConcurrent: 6,
			title: "Converting comment style…",
			task: async (file) => {
				const counts = { converted: 0, skipped: 0 };
				await this.convertSingleFileInternal(
					file,
					targetStyle as CommentStyle,
					counts,
				);
				return counts;
			},
		});

		// Aggregate just for logging (no UI Notice here)
		const totals = results.reduce(
			(acc, r) => {
				acc.converted += r.converted;
				acc.skipped += r.skipped;
				return acc;
			},
			{ converted: 0, skipped: 0 },
		);
		this.log.info(
			`Comment style conversion finished - ${totals.converted} converted, ${totals.skipped} skipped`,
		);
	}

	private async checkIfConvertingFromNoneInternal(
		targetStyle: string,
	): Promise<void> {
		if (targetStyle === "none") return;

		const { files } = await this.fs.getFilesInFolder(
			this.plugin.settings.highlightsFolder,
			{ extensions: ["md"], recursive: false },
		);
		if (!files?.length) return;

		const sampleFiles = files.slice(0, 3);
		let hasFilesWithoutComments = false;
		for (const file of sampleFiles) {
			try {
				const { body } = await this.frontmatterService.parseFile(file);
				const { annotations } = extractHighlightsWithStyle(body, "html");
				const { annotations: mdAnnotations } = extractHighlightsWithStyle(
					body,
					"md",
				);

				if (
					annotations.length === 0 &&
					mdAnnotations.length === 0 &&
					body.trim().length > 100
				) {
					hasFilesWithoutComments = true;
					break;
				}
			} catch (_error) {
				// ignore
			}
		}

		if (hasFilesWithoutComments) {
			this.log.warn(
				"Detected files without KOHL comments during conversion to comment style",
			);
		}
	}

	private async getHighlightFilesToConvertInternal(): Promise<TFile[] | null> {
		const folderPath = this.plugin.settings.highlightsFolder;
		if (!folderPath) {
			this.log.warn(
				"Highlights folder not configured for comment style conversion.",
			);
			return null;
		}

		const { files } = await this.fs.getFilesInFolder(folderPath, {
			extensions: ["md"],
			recursive: false,
		});

		if (files.length === 0) {
			this.log.info("No files found to convert.");
			return null;
		}

		return files;
	}

	private async convertSingleFileInternal(
		file: TFile,
		targetStyle: CommentStyle,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		try {
			const { frontmatter, body } =
				await this.frontmatterService.parseFile(file);

			if (targetStyle === "none") {
				await this.convertToNoneStyleInternal(file, body, frontmatter, counts);
			} else {
				await this.convertToCommentStyleInternal(
					file,
					body,
					frontmatter,
					targetStyle,
					counts,
				);
			}
		} catch (error) {
			this.log.error(`Error converting file ${file.path}:`, error);
			counts.skipped++;
		}
	}

	private async convertToNoneStyleInternal(
		file: TFile,
		body: string,
		frontmatter: Record<string, unknown> | undefined,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		const { usedStyle } = extractHighlightsWithStyle(body, "html");
		const newBody = usedStyle
			? convertCommentStyle(body, usedStyle, "none")
			: convertCommentStyle(
					convertCommentStyle(body, "html", "none"),
					"md",
					"none",
				);
		counts.converted++;
		this.log.info(`Removing KOHL comments from ${file.path}`);

		const newContent = this.frontmatterService.reconstructFileContent(
			frontmatter ?? {},
			newBody,
		);
		await this.fs.writeVaultFile(file.path, newContent);
	}

	private async convertToCommentStyleInternal(
		file: TFile,
		body: string,
		frontmatter: Record<string, unknown> | undefined,
		targetStyle: CommentStyle,
		counts: { converted: number; skipped: number },
	): Promise<void> {
		const { annotations, usedStyle } = extractHighlightsWithStyle(
			body,
			targetStyle,
		);

		if (annotations.length === 0 && body.trim().length > 100) {
			this.log.info(
				`File ${file.path} appears to have no KOHL comments - likely "none" style`,
			);
			counts.skipped++;
			return;
		}

		if (annotations.length === 0) {
			counts.skipped++;
			return;
		}

		let newBody = body;

		if (usedStyle && usedStyle !== targetStyle) {
			newBody = convertCommentStyle(body, usedStyle, targetStyle);
			counts.converted++;
			this.log.info(
				`Converting ${file.path} from ${usedStyle} to ${targetStyle} style`,
			);
		} else if (usedStyle === targetStyle) {
			counts.skipped++;
			this.log.info(`Skipping ${file.path} – already in ${targetStyle} style`);
			return;
		} else {
			counts.skipped++;
			return;
		}

		const newContent = this.frontmatterService.reconstructFileContent(
			frontmatter ?? {},
			newBody,
		);
		await this.fs.writeVaultFile(file.path, newContent);
	}

	/**
	 * Forces CapabilityManager to refresh all probes, bypassing TTL/backoff.
	 * Useful when environment changes (e.g., vault remounted read-write).
	 */
	async executeRecheckCapabilities(): Promise<CmdResult<{ message: string }>> {
		try {
			const snap = await this.capabilities.refreshAll(true);
			const msg = `Capabilities: snapshotsWritable=${snap.areSnapshotsWritable ? "ok" : "unavailable"}, indexPersistent=${snap.isPersistentIndexAvailable ? "ok" : "unavailable"}`;
			this.log.info("Capability refresh complete.", snap);
			return { status: "success" as const, data: { message: msg } };
		} catch (e) {
			this.log.error("Capability refresh failed", e);
			return { status: "error" as const, error: e };
		}
	}

	/**
	 * Refreshes highlights for the provided note (or current active note).
	 * Returns true if anything changed.
	 */
	async executeRefreshCurrentNote(
		file?: TFile,
	): Promise<CmdResult<{ changed: boolean }>> {
		const active = file ?? this.app.workspace.getActiveFile();
		if (!active) {
			return { status: "skipped" as const, data: { changed: false } };
		}

		try {
			const changed = await this.refreshNote(active);
			return { status: "success" as const, data: { changed } };
		} catch (e) {
			this.log.error("Book refresh failed", e as Error);
			return { status: "error" as const, error: e };
		}
	}

	/** Refresh one note. Returns true if anything changed. */
	private async refreshNote(note: TFile): Promise<boolean> {
		const bookKey = await this.localIndexService.findKeyByVaultPath(note.path);
		if (!bookKey)
			throw new Error("This note is not tracked in the KOReader index");

		const src = await this.localIndexService.latestSourceForBook(bookKey);
		if (!src) throw new Error("No source metadata.lua recorded for this book");

		const mount = await this.device.getActiveScanPath();
		if (!mount) throw new Error("KOReader device not connected");

		const fullSrcPath = path.join(mount, src);
		if (!(await this.fs.nodeFileExists(fullSrcPath))) {
			throw new Error("metadata.lua not found on device");
		}

		const result = await this.importPipelineService.runSingleFilePipeline({
			metadataPath: fullSrcPath,
			existingNoteOverride: note,
		});

		this.log.info(
			`Refresh finished for ${note.path}: created=${result.fileSummary.created}, merged=${result.fileSummary.merged}, automerged=${result.fileSummary.automerged}, skipped=${result.fileSummary.skipped}`,
		);

		return result.changed;
	}
}
