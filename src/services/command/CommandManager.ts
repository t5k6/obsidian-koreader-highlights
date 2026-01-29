import { type App, type Command, Notice, type TFile } from "obsidian";
import type { CacheManager } from "src/lib/cache/CacheManager";
import { isAbortError, runPool } from "src/lib/concurrency";
import { err, isErr, ok } from "src/lib/core/result";
import type { AppFailure, AppResult } from "src/lib/errors/types";
import { convertKohlMarkers } from "src/lib/kohlMarkers";
import { parse as parseMetadata } from "src/lib/parsing/luaParser";
import { Pathing } from "src/lib/pathing";
import type KoreaderImporterPlugin from "src/main";
import type { ImportService } from "src/services/import/ImportService";
import { notifyOnError } from "src/services/ui/notificationUtils";
import { InteractionModal } from "src/ui/InteractionModal";
import { withProgress } from "src/ui/utils/progress";
import type { DeviceService } from "../device/DeviceService";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { NoteEditorService } from "../parsing/NoteEditorService";
import type { IndexCoordinator } from "../vault/index/IndexCoordinator";
import type { NotePersistenceService } from "../vault/NotePersistenceService";

// Unified command result types
type CmdStatus = "success" | "cancelled" | "skipped" | "error";
type CmdResult<T = void> = { status: CmdStatus; data?: T; error?: unknown };

type ConversionSummary = {
	scanned: number;
	changed: number;
};

export class CommandManager {
	private readonly log;
	private static readonly SCAN_REPORT_FILENAME = "KOReader SDR Scan Report.md";

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly ImportService: ImportService,
		private readonly device: DeviceService,
		private readonly cacheManager: CacheManager,
		private readonly loggingService: LoggingService,
		private readonly localIndexService: IndexCoordinator,
		private readonly fs: FileSystemService,
		private readonly noteEditorService: NoteEditorService,
		private readonly persistence: NotePersistenceService,
	) {
		this.log = this.loggingService.scoped("CommandManager");
	}

	/**
	 * UI helper: pipes a CmdResult-producing operation through notifyOnError.
	 * This centralizes Notice creation for errors while preserving CmdResult shape.
	 */
	private async notifyCmd<D>(
		operation: Promise<AppResult<D>>,
		opts?: { message?: string | ((err: unknown) => string); timeout?: number },
	): Promise<CmdResult<D>> {
		try {
			const res = await operation;
			if (isErr(res)) {
				await notifyOnError(Promise.resolve(res), {
					message:
						typeof opts?.message === "function"
							? opts.message
							: () => (opts?.message as string) ?? "Operation failed",
					timeout: opts?.timeout,
				});
				return { status: "error" as const, error: res.error };
			}
			return { status: "success" as const, data: res.value };
		} catch (e) {
			if (isAbortError(e)) return { status: "cancelled" as const };
			// Unexpected error path: log and surface a notice
			this.log.error("Command failed unexpectedly", e);
			await notifyOnError(Promise.resolve(err(e)), {
				message:
					typeof opts?.message === "function"
						? opts.message
						: () => (opts?.message as string) ?? "Operation failed",
				timeout: opts?.timeout,
			});
			return { status: "error" as const, error: e };
		}
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
						const res = await this.notifyCmd(this.executeImport());
						if (res.status === "cancelled") {
							new Notice("Import cancelled.");
						}
					})();
				},
			},
			{
				id: "scan-koreader-highlights",
				name: "Scan KOReader for Highlights",
				callback: () => {
					void (async () => {
						const res = await this.notifyCmd<{
							fileCount: number;
							reportPath: string | null;
						}>(this.executeScan(), {
							message: () => "Scan failed. Check console for details.",
						});
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
						}
					})();
				},
			},
			{
				id: "convert-comment-style",
				name: "Convert All Files to Current Comment Style",
				callback: () => {
					void (async () => {
						const res = await this.notifyCmd(
							this.executeConvertCommentStyle(),
							{
								message: () => "Conversion failed. Check console for details.",
							},
						);
						if (res.status === "cancelled") new Notice("Conversion cancelled.");
						// success: silent to preserve previous UX
					})();
				},
			},
			{
				id: "clear-koreader-importer-caches",
				name: "Clear in-memory caches",
				callback: () => {
					void (async () => {
						const res = await this.notifyCmd(this.executeClearCaches(), {
							message: () =>
								"Failed to clear caches. Check console for details.",
						});
						if (res.status === "success") {
							new Notice("KOReader Importer caches cleared.");
						}
					})();
				},
			},
			{
				id: "force-import-koreader-highlights",
				name: "Force Re-scan and Import KOReader Highlights",
				callback: () => {
					void (async () => {
						const res = await this.notifyCmd(this.executeForceImport());
						if (res.status === "cancelled") {
							new Notice("Force import cancelled.");
						}
					})();
				},
			},
			{
				id: "reset-koreader-importer",
				name: "Troubleshoot: Full Reset and Reload Plugin",
				callback: () => {
					void (async () => {
						const confirmed = await InteractionModal.confirm(this.app, {
							title: "Reset KOReader Importer?",
							message:
								"This will delete the plugin's index files and caches. Your actual highlight notes in the vault are not affected. This action will also reload the plugin to ensure a completely clean state. Continue?",
							ctaText: "Proceed",
						});
						if (!confirmed) return { status: "cancelled" as const };
						const res = await this.notifyCmd(this.executeFullReset(), {
							message: () =>
								"Error during reset. Check the developer console for details.",
							timeout: 10000,
						});
						if (res.status === "success") {
							new Notice(
								"KOReader Importer has been reset. Reloading plugin now...",
								5000,
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
						const res = await this.notifyCmd<{ message?: string }>(
							this.executeRecheckCapabilities(),
							{
								message: () =>
									"Failed to re-check capabilities. See console for details.",
								timeout: 7000,
							},
						);
						if (res.status === "success" && res.data?.message) {
							new Notice(`KOReader Importer: ${res.data.message}`, 5000);
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
						void this.notifyCmd<{ changed: boolean }>(
							this.executeRefreshCurrentNote(file),
							{ message: () => "Refresh failed. See console for details." },
						)
							.then((res) => {
								if (res.status === "skipped") {
									new Notice("No active file to refresh.", 4000);
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
								// Should be rare since notifyCmd swallows error into result; log just in case
								console.error("Book refresh failed", e);
							});
					}
					return true;
				},
			},
			{
				id: "cleanup-orphaned-data",
				name: "Clean up orphaned data files",
				callback: () => {
					void (async () => {
						const res = await this.notifyCmd(
							this.executeCleanupOrphanedData(),
							{
								message: () => "Cleanup failed. Check console for details.",
							},
						);
						if (res.status === "success" && res.data) {
							const { deleted } = res.data;
							new Notice(
								`Cleaned up ${deleted} orphaned snapshot file${deleted === 1 ? "" : "s"}.`,
								5000,
							);
						}
					})();
				},
			},
			{
				id: "finalize-note",
				name: "KOReader: Finalize note (remove tracking comments)",
				icon: "check-circle",
				checkCallback: (checking) => {
					const file = this.app.workspace.getActiveFile();
					if (!file || file.extension !== "md") return false;
					// Only show command if file is in highlights folder
					if (
						!Pathing.isAncestor(
							this.plugin.settings.highlightsFolder,
							file.path,
						)
					)
						return false;
					if (!checking) {
						void this.notifyCmd<{ changed: boolean }>(
							this.executeFinalizeCurrentNote(file),
							{ message: () => "Finalize failed. See console for details." },
						)
							.then((res) => {
								if (res.status === "skipped") {
									new Notice("No active file to finalize.", 4000);
									return;
								}
								const changed = !!res.data?.changed;
								new Notice(
									changed
										? "KOReader tracking comments removed from this note."
										: "No tracking comments found in this note.",
									5000,
								);
							})
							.catch((e: any) => {
								// Should be rare since notifyCmd swallows error into result; log just in case
								console.error("Finalize failed", e);
							});
					}
					return true;
				},
			},
			{
				id: "cleanup-completed-books",
				name: "KOReader: Clean up comments from all completed books",
				callback: () => {
					void (async () => {
						const res = await this.notifyCmd<{
							scanned: number;
							changed: number;
						}>(this.executeCleanupCompletedBooks(), {
							message: () => "Cleanup failed. See console for details.",
						});
						if (res.status === "success") {
							const { changed, scanned } = res.data ?? {
								changed: 0,
								scanned: 0,
							};
							new Notice(
								changed > 0
									? `Cleaned up ${changed} completed book${changed === 1 ? "" : "s"} (${scanned} total scanned).`
									: `No changes needed. Scanned ${scanned} file${scanned === 1 ? "" : "s"}.`,
								5000,
							);
						} else if (res.status === "cancelled") {
							new Notice("Cleanup cancelled.");
						}
					})();
				},
			},
		];
	}

	/**
	 * Force re-scan and import (clear caches then immediately import).
	 */
	async executeForceImport(): Promise<AppResult<void>> {
		this.device.clearCache();
		this.plugin.statusBarManager?.clearCache();
		this.localIndexService.invalidateIndexCaches();
		await this.localIndexService.clearImportSource();
		return this.executeImport({ forceReimportAll: true });
	}

	/**
	 * Trigger full reset with confirmation.
	 */
	async executeFullResetWithConfirm(): Promise<CmdResult> {
		const confirmed = await InteractionModal.confirm(this.app, {
			title: "Reset KOReader Importer?",
			message:
				"This will delete the plugin's index files and caches. Your actual highlight notes in the vault are not affected. This action will also reload the plugin to ensure a completely clean state. Continue?",
			ctaText: "Proceed",
		});
		if (!confirmed) return { status: "cancelled" as const };
		return this.notifyCmd(this.executeFullReset());
	}

	/**
	 * Ensures the KOReader scan path is available and settings are up-to-date.
	 * @returns The scan path if successful, otherwise null.
	 */
	private async prepareExecution(): Promise<AppResult<string>> {
		const rawMountPoint = await this.device.getActiveScanPath();
		if (!rawMountPoint) {
			this.log.warn("Scan path not available. Aborting command execution.");
			const configuredPath = this.plugin.settings.koreaderScanPath;
			return err({
				kind: "ConfigInvalid",
				field: "KOReader Scan Path",
				reason: `The configured path "${configuredPath}" could not be found or is not a directory. Please check the path in the plugin settings and ensure your device is connected.`,
			});
		}

		const mountPoint = Pathing.normalizeSystemPath(rawMountPoint);

		if (mountPoint !== this.plugin.settings.koreaderScanPath) {
			this.log.info(`Using scan path: ${mountPoint}`);
			this.plugin.settings.koreaderScanPath = mountPoint;
			await this.plugin.saveSettings();
		}

		return ok(mountPoint);
	}

	/**
	 * Executes the highlight import process.
	 * Validates scan path availability before starting import.
	 * Handles cancellation and error reporting.
	 */
	async executeImport(options?: {
		forceReimportAll?: boolean;
		signal?: AbortSignal;
	}): Promise<AppResult<void>> {
		this.log.info("Import triggered.");

		const mount = await this.prepareExecution();
		if (isErr(mount)) return mount;

		await this.ImportService.importHighlights(options);
		return ok(void 0);
	}

	/**
	 * Clears in-memory and persistent caches to force a fresh import next time.
	 */
	async executeClearCaches(): Promise<AppResult<void>> {
		this.log.info("Clearing caches on user request.");
		this.cacheManager.clear();
		this.device.clearCache();
		this.plugin.statusBarManager?.clearCache();
		// Use centralized cache invalidation for index-related caches
		this.localIndexService.invalidateIndexCaches();
		await this.localIndexService.clearImportSource();
		return ok(void 0);
	}

	/**
	 * Executes a scan for available highlights without importing.
	 * Shows what files would be processed in an import.
	 */
	async executeScan(options?: {
		signal?: AbortSignal;
	}): Promise<AppResult<{ fileCount: number; reportPath: string | null }>> {
		this.log.info("Scan triggered.");

		const mount = await this.prepareExecution();
		if (isErr(mount)) return mount;

		let count = 0;
		const scanResult = await withProgress(
			this.app,
			0,
			async (tick, signal) => {
				tick.setStatus("Scanning for KOReader highlight files...");
				const sdrFilePaths = await this.device.findSdrDirectoriesWithMetadata({
					signal,
				});

				if (!sdrFilePaths || sdrFilePaths.length === 0) {
					this.log.info("Scan complete. No SDR files found.");
					const r = await this.createOrUpdateScanNote([], []);
					if (isErr(r)) return r;
					return ok(undefined);
				}

				this.log.info(
					`Scan found ${sdrFilePaths.length} metadata files. Analyzing contents...`,
				);
				tick.setStatus(
					`Found ${sdrFilePaths.length} files. Analyzing contents for highlights...`,
				);
				tick.setTotal(sdrFilePaths.length);

				const filesWithHighlights: string[] = [];
				const filesWithoutHighlights: string[] = [];
				const scanStream = runPool(
					sdrFilePaths,
					async (path) => {
						// Read file content
						const contentRes = await this.fs.readNodeFileText(path);
						if (isErr(contentRes)) {
							this.log.warn(`Failed to read content for scan: ${path}`);
							filesWithoutHighlights.push(path); // Treat error as no highlights for now
							return;
						}

						// Parse Lua
						const parseRes = parseMetadata(contentRes.value);
						if (isErr(parseRes)) {
							this.log.warn(`Failed to parse content for scan: ${path}`);
							filesWithoutHighlights.push(path);
							return;
						}

						// Check for annotations
						const { meta } = parseRes.value;
						if (meta.annotations && meta.annotations.length > 0) {
							filesWithHighlights.push(path);
						} else {
							filesWithoutHighlights.push(path);
						}
						tick();
					},
					{ concurrency: 16, signal },
				);

				for await (const res of scanStream) {
					// Check for worker errors (unexpected throws)
					if (!res.ok && !isAbortError(res.error)) {
						this.log.warn("Error during scan analysis worker", res.error);
					}
				}

				count = filesWithHighlights.length;
				this.log.info(
					`Scan analysis complete. Found ${count} files with annotations (out of ${sdrFilePaths.length} total SDRs).`,
				);

				tick.setStatus(
					`Found ${count} books with highlights (${filesWithoutHighlights.length} without). Generating report...`,
				);
				const r = await this.createOrUpdateScanNote(
					filesWithHighlights,
					filesWithoutHighlights,
				);
				if (isErr(r)) return r;
				return ok(undefined);
			},
			{
				title: "Scanning KOReader Highlights",
				showWhenTotalIsZero: true,
				autoMessage: false,
				signal: options?.signal,
			},
		);

		if (isErr(scanResult)) {
			return scanResult; // Propagate the error
		}

		return ok({
			fileCount: count,
			reportPath: CommandManager.SCAN_REPORT_FILENAME,
		});
	}

	/**
	 * Creates or updates the scan report file in the vault.
	 * @param filesWithHighlights - Array of metadata file paths with highlights
	 * @param filesWithoutHighlights - Array of metadata file paths without highlights
	 */
	private async createOrUpdateScanNote(
		filesWithHighlights: string[],
		filesWithoutHighlights: string[],
	): Promise<AppResult<void>> {
		const reportFilename = CommandManager.SCAN_REPORT_FILENAME;
		const reportFolderPath = this.plugin.settings.highlightsFolder;
		const fullReportPath = `${reportFolderPath}/${reportFilename}`;

		const mountPoint = await this.device.getActiveScanPath();
		const reportContent = this.generateReportContent(
			filesWithHighlights,
			filesWithoutHighlights,
			mountPoint ?? "",
		);

		this.log.info(`Creating or updating scan report: ${fullReportPath}`);
		const r = await this.fs.writeVaultTextAtomic(fullReportPath, reportContent);
		if (isErr(r)) {
			this.log.error(
				`Error creating/updating scan report note at ${fullReportPath}:`,
				r.error,
			);
			return err(r.error as AppFailure);
		}
		return ok(void 0);
	}

	/**
	 * Generates the markdown content for the scan report note.
	 */
	private generateReportContent(
		filesWithHighlights: string[],
		filesWithoutHighlights: string[],
		usedMountPoint: string,
	): string {
		const usedMount = usedMountPoint || this.plugin.settings.koreaderScanPath;
		let content = `# KOReader SDR Scan Report\n\n`;
		content += `Scan path: ${usedMount || "<unknown>"}\n\n`;
		content += `Scan time: ${new Date().toLocaleString()}\n\n`;

		if (filesWithHighlights.length === 0 && filesWithoutHighlights.length === 0) {
			content += `No KOReader highlight metadata files (SDR) were found.\n`;
			return content;
		}

		// Helper to format list
		const formatList = (paths: string[]) => {
			if (paths.length === 0) return "_None_\n";
			return (
				paths
					.map((metadataFilePath) => {
						const relativePath = usedMount
							? Pathing.systemRelative(usedMount, metadataFilePath).replace(
								/\\/g,
								"/",
							)
							: metadataFilePath;
						return `- \`${relativePath}\``;
					})
					.join("\n") + "\n"
			);
		};

		content += `## Books with Highlights (${filesWithHighlights.length})\n\n`;
		content += formatList(filesWithHighlights);

		content += `\n## Books without Highlights (${filesWithoutHighlights.length})\n\n`;
		content += formatList(filesWithoutHighlights);

		return content;
	}

	/**
	 * Converts the comment style of the given note.
	 */
	async executeConvertCommentStyle(options?: {
		signal?: AbortSignal;
	}): Promise<AppResult<void>> {
		this.log.info("Converting all highlight notes to current comment style...");
		// The core logic is now a private method of this class.
		const summary = await this._convertAllToCurrentStyle(options?.signal);
		this.log.info(
			`Conversion complete. Scanned: ${summary.scanned}, Changed: ${summary.changed}`,
		);
		return ok(void 0);
	}

	/**
	 * Re-checks the capabilities of the device.
	 */
	public async executeRecheckCapabilities(): Promise<
		AppResult<{ message?: string }>
	> {
		this.log.info("Performing reactive capability check...");
		const pluginDirWritable = await this.fs.isPluginDirWritable();
		const message = pluginDirWritable
			? "Plugin data folder is writable. Snapshots and index should be available."
			: "Plugin data folder is NOT writable. Snapshots and persistent index will be disabled.";
		this.log.info(`Capability check result: ${message}`);
		return ok({ message });
	}

	/**
	 * Executes a full reset of the plugin.
	 */
	async executeFullReset(): Promise<AppResult<void>> {
		this.log.warn("Full reset requested by user.");
		// 1) Clear in-memory caches and import source index so next import is fresh
		this.cacheManager.clear();
		this.device.clearCache();
		this.plugin.statusBarManager?.clearCache();
		// Use centralized cache invalidation for index-related caches
		this.localIndexService.invalidateIndexCaches();
		await this.localIndexService.clearImportSource();

		// 2) Remove plugin data directory contents (Result-based, resilient)
		const listing = await this.fs.listPluginDataDir();
		if (!isErr(listing)) {
			const { files, folders } = listing.value;
			for (const f of files) {
				const r = await this.fs.removePluginDataPath(f);
				if (isErr(r))
					this.log.warn(`Failed to remove data file: ${f}`, r.error);
			}
			for (const d of folders) {
				const r = await this.fs.removePluginDataPath(d);
				if (isErr(r))
					this.log.warn(`Failed to remove data folder: ${d}`, r.error);
			}
		} else {
			this.log.warn(
				"Could not list plugin data dir; proceeding with reset.",
				listing.error,
			);
		}

		// 3) Reload the plugin to ensure a clean state
		await this.plugin.reloadPlugin();
		return ok(void 0);
	}

	/**
	 * Refreshes the current note.
	 * @param file - The file to refresh
	 */
	async executeRefreshCurrentNote(
		file: TFile,
	): Promise<AppResult<{ changed: boolean }>> {
		// Ensure local index is ready before querying
		await this.localIndexService.whenReady?.();
		// Resolve conceptual book key for this note
		const bookKey = await this.localIndexService.findKeyByVaultPath(file.path);
		if (!bookKey) {
			this.log.info(`No indexed book key for ${file.path}; skipping refresh.`);
			return ok({ changed: false });
		}

		// Find latest metadata source file for this book
		const latest = await this.localIndexService.latestSourceForBook(bookKey);
		if (!latest) {
			this.log.info(
				`No known source metadata for book ${bookKey}; nothing to refresh.`,
			);
			return ok({ changed: false });
		}

		// Re-run single-file pipeline
		const { changed } = await this.ImportService.runSingleFilePipeline({
			metadataPath: latest,
			existingNoteOverride: file,
		});
		return ok({ changed: !!changed });
	}

	/**
	 * Executes cleanup of orphaned snapshot data files.
	 */
	public async executeCleanupOrphanedData(): Promise<
		AppResult<{
			scanned: number;
			deleted: number;
			failed: number;
		}>
	> {
		this.log.info("Cleanup orphaned data triggered by user command.");
		const result = await this.persistence.collectOrphanedSnapshots(
			this.plugin.settings.highlightsFolder,
		);
		return ok(result);
	}

	/**
	 * Finalizes a single note by removing Kohl tracking comments.
	 * @param file - The file to finalize
	 */
	async executeFinalizeCurrentNote(
		file: TFile,
	): Promise<AppResult<{ changed: boolean }>> {
		const result = await this._convertSingleFile(file, "none");
		if (isErr(result)) return result;
		return ok({ changed: result.value });
	}

	/**
	 * Cleans up comments from all completed books.
	 * Finds files with readingStatus: 'completed', shows confirmation, then processes batch.
	 */
	async executeCleanupCompletedBooks(): Promise<
		AppResult<{ scanned: number; changed: number }>
	> {
		const folder = this.plugin.settings.highlightsFolder;
		const summary: ConversionSummary = { scanned: 0, changed: 0 };

		// Find all MD files in highlights folder
		const { files } = await this.fs.getFilesInFolder(folder, {
			extensions: ["md"],
			recursive: true,
		});

		// Filter for completed books
		const completedFiles: TFile[] = [];
		for (const file of files) {
			const frontmatter =
				this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (frontmatter && frontmatter["readingStatus"] === "completed") {
				completedFiles.push(file);
			}
		}

		summary.scanned = files.length; // We scanned all files, but filtered for completed

		if (completedFiles.length === 0) {
			return ok({ scanned: summary.scanned, changed: 0 });
		}

		// Show confirmation
		const fileList =
			completedFiles.length <= 10
				? completedFiles.map((f) => f.basename).join(", ")
				: `${completedFiles.length} files`;

		const confirmed = await InteractionModal.confirm(this.app, {
			title: `Clean up ${completedFiles.length} completed book${completedFiles.length === 1 ? "" : "s"}?`,
			message: `Found ${completedFiles.length} completed books: ${fileList}. Remove tracking comments from these files? This action cannot be undone.`,
			ctaText: "Clean up",
		});

		if (!confirmed) {
			// Handle cancellation properly
			return ok({ scanned: summary.scanned, changed: 0 });
		}

		// Process batch with error handling
		try {
			await withProgress(
				this.app,
				0,
				async (tick, signal) => {
					tick.setStatus(
						`Processing ${completedFiles.length} completed books...`,
					);
					tick.setTotal(completedFiles.length);

					await runPool(
						completedFiles,
						async (file: TFile) => {
							tick.setStatus(`Cleaning: ${file.name}`);
							const result = await this._convertSingleFile(file, "none");
							if (isErr(result)) {
								this.log.warn(`Failed to clean ${file.path}`, result.error);
							} else if (result.value) {
								summary.changed++;
							}
							tick();
						},
						{ concurrency: 4, signal },
					);
				},
				{
					title: "Cleaning up completed books",
					showWhenTotalIsZero: true,
					autoMessage: false,
				},
			);
		} catch (error) {
			// Handle any unexpected errors from withProgress
			this.log.error("Error during batch cleanup", error);
			return err({
				kind: "WriteFailed",
				path: "batch_cleanup",
				cause: error,
			} as any);
		}

		return ok({ scanned: summary.scanned, changed: summary.changed });
	}

	/**
	 * Convert all highlight notes in the configured highlights folder to the
	 * current comment style defined in settings.commentStyle.
	 * Uses progress UI, supports cancellation, and runs with bounded concurrency.
	 */
	private async _convertAllToCurrentStyle(
		signal?: AbortSignal,
	): Promise<ConversionSummary> {
		const folder = this.plugin.settings.highlightsFolder;
		const summary: ConversionSummary = { scanned: 0, changed: 0 };

		await withProgress(
			this.app,
			0,
			async (tick, signal) => {
				tick.setStatus("Scanning highlight notes...");
				// In CommandManager, the FileSystemService is `this.fs`
				const { files } = await this.fs.getFilesInFolder(folder, {
					extensions: ["md"],
					recursive: true,
				});
				summary.scanned = files.length;
				if (files.length === 0) return;

				tick.setTotal(files.length);
				const targetStyle = this.plugin.settings.commentStyle;

				await runPool(
					files,
					// Provide explicit type for the worker parameter
					async (file: TFile) => {
						tick.setStatus(`Converting: ${file.name}`);
						const result = await this._convertSingleFile(file, targetStyle);
						if (isErr(result)) {
							this.log.warn(`Failed to convert ${file.path}`, result.error);
						} else if (result.value) {
							summary.changed++;
						}
						tick();
					},
					{ concurrency: 4, signal },
				);
			},
			{
				title: "Converting comment style",
				showWhenTotalIsZero: true,
				autoMessage: false,
				signal,
			},
		);

		return summary;
	}

	private async _convertSingleFile(
		file: TFile,
		target: "html" | "md" | "none",
	): Promise<AppResult<boolean>> {
		try {
			const parsed = await this.noteEditorService.parseFile(file);

			if (isErr(parsed)) {
				this.log.warn(
					`Skipping conversion for ${file.path} due to parsing error.`,
					parsed.error,
				);
				return err({
					kind: "YamlParseError",
					message: `Failed to parse frontmatter in ${file.path}`,
				});
			}

			const currentBody = parsed.value.body ?? "";
			const nextBody = convertKohlMarkers(currentBody, target);
			if (nextBody === currentBody) return ok(false);

			const editResult = await this.noteEditorService.editFile(
				file,
				(doc) => ({ frontmatter: doc.frontmatter, body: nextBody }),
				{ skipIfNoChange: true, detectConcurrentModification: true },
			);

			if (isErr(editResult)) {
				this.log.warn(`Failed to edit ${file.path}`, editResult.error);
				return err(editResult.error);
			}

			return ok(editResult.value.changed);
		} catch (e) {
			this.log.warn(`Unexpected error during conversion of ${file.path}`, e);
			return err({ kind: "WriteFailed", path: file.path, cause: e });
		}
	}
}
