import { type App, type Command, Notice, type TFile } from "obsidian";
import type { CacheManager } from "src/lib/cache/CacheManager";
import { isAbortError, runPool } from "src/lib/concurrency";
import { err, isErr, ok } from "src/lib/core/result";
import { safeParse } from "src/lib/core/validationUtils";
import type { AppFailure, AppResult } from "src/lib/errors";
import { normalizeSystemPath } from "src/lib/pathing";
import type KoreaderImporterPlugin from "src/main";
import type { CapabilityManager } from "src/services/CapabilityManager";
import type { ImportService } from "src/services/import/ImportService";
import { notifyOnError } from "src/services/ShellUtils";
import { ConfirmModal } from "src/ui/ConfirmModal";
import { withProgress } from "src/ui/utils/progress";
import type { DeviceService } from "../device/DeviceService";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { FrontmatterService } from "../parsing/FrontmatterService";
import type { IndexCoordinator } from "../vault/index/IndexCoordinator";

// Unified command result types
type CmdStatus = "success" | "cancelled" | "skipped" | "error";
type CmdResult<T = void> = { status: CmdStatus; data?: T; error?: unknown };

type ConversionSummary = {
	scanned: number;
	changed: number;
};

// A single, efficient regex to find any KOHL marker (HTML or Markdown style)
// and capture its JSON payload. This is more robust than chaining two separate regexes.
const ANY_KOHL_MARKER_REGEX = new RegExp(
	// Non-capturing group for the opening delimiter
	/(?:<!--|%%)/.source +
		// Whitespace and the KOHL keyword
		/\s*KOHL\s*/.source +
		// Capturing group 1: The JSON payload itself. [\s\S]*? is a non-greedy match for any character including newlines.
		/({[\s\S]*?})/.source +
		// Whitespace and the closing delimiter
		/\s*(?:-->|%%)/.source,
	"g", // Global flag to find all occurrences
);

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
		private readonly capabilityManager: CapabilityManager,
		private readonly fmService: FrontmatterService,
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
						const res = await this.notifyCmd(this.executeImport(), {
							message: () => "Import failed. Check console for details.",
						});
						if (res.status === "cancelled") {
							new Notice("Import cancelled.");
						}
						// success: ImportService shows its own summary
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
						const res = await this.notifyCmd(this.executeForceImport(), {
							message: () => "Force import failed. Check console for details.",
						});
						if (res.status === "cancelled") {
							new Notice("Force import cancelled.");
						}
						// success: ImportService will show summary
					})();
				},
			},
			{
				id: "reset-koreader-importer",
				name: "Troubleshoot: Full Reset and Reload Plugin",
				callback: () => {
					void (async () => {
						const confirmed =
							(await new ConfirmModal(
								this.app,
								"Reset KOReader Importer?",
								"This will delete the plugin's index files and caches. Your actual highlight notes in the vault are not affected. This action will also reload the plugin to ensure a completely clean state. Continue?",
							).openAndAwaitResult()) ?? false;
						if (!confirmed) return;
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
		];
	}

	/**
	 * Force re-scan and import (clear caches then immediately import).
	 */
	async executeForceImport(): Promise<AppResult<void>> {
		const cleared = await this.executeClearCaches();
		if (isErr(cleared)) return cleared;
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
			return err({
				kind: "CAPABILITY_DENIED",
				capability: "koreader_scan_path",
				message: "Scan path not available",
			} satisfies AppFailure);
		}

		const mountPoint = normalizeSystemPath(rawMountPoint);

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
	async executeImport(): Promise<AppResult<void>> {
		this.log.info("Import triggered.");

		const mount = await this.prepareExecution();
		if (isErr(mount)) return mount;

		this.device.clearCache();
		await this.ImportService.importHighlights();
		return ok(void 0);
	}

	/**
	 * Clears in-memory and persistent caches to force a fresh import next time.
	 */
	async executeClearCaches(): Promise<AppResult<void>> {
		this.log.info("Clearing caches on user request.");
		this.cacheManager.clear();
		this.device.clearCache();
		// Use centralized cache invalidation for index-related caches
		this.localIndexService.invalidateIndexCaches();
		await this.localIndexService.clearImportSource();
		return ok(void 0);
	}

	/**
	 * Executes a scan for available highlights without importing.
	 * Shows what files would be processed in an import.
	 */
	async executeScan(): Promise<
		AppResult<{ fileCount: number; reportPath: string | null }>
	> {
		this.log.info("Scan triggered.");

		const mount = await this.prepareExecution();
		if (isErr(mount)) return mount;

		let count = 0;
		await withProgress(
			this.app,
			0,
			async (tick, signal) => {
				tick.setStatus("Scanning for KOReader highlight files...");
				const sdrFilePaths =
					await this.device.findSdrDirectoriesWithMetadata(/* signal */);
				count = sdrFilePaths?.length ?? 0;
				if (!sdrFilePaths || sdrFilePaths.length === 0) {
					this.log.info("Scan complete. No SDR files found.");
					const r = await this.createOrUpdateScanNote([]);
					if (isErr(r)) throw r.error; // surface predictable failure to wrapper
					return;
				}

				this.log.info(`Scan found ${sdrFilePaths.length} metadata files.`);
				tick.setStatus(
					`Found ${sdrFilePaths.length} files. Generating report...`,
				);
				const r = await this.createOrUpdateScanNote(sdrFilePaths);
				if (isErr(r)) throw r.error;
			},
			{
				title: "Scanning KOReader Highlights",
				showWhenTotalIsZero: true,
				autoMessage: false,
			},
		);
		return ok({
			fileCount: count,
			reportPath: CommandManager.SCAN_REPORT_FILENAME,
		});
	}

	/**
	 * Creates or updates the scan report file in the vault.
	 * @param sdrFilePaths - Array of metadata file paths found
	 */
	private async createOrUpdateScanNote(
		sdrFilePaths: string[],
	): Promise<AppResult<void>> {
		const reportFilename = CommandManager.SCAN_REPORT_FILENAME;
		const reportFolderPath = this.plugin.settings.highlightsFolder;
		const fullReportPath = `${reportFolderPath}/${reportFilename}`;

		const mountPoint = await this.device.getActiveScanPath();
		const reportContent = this.generateReportContent(
			sdrFilePaths,
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
	async executeConvertCommentStyle(): Promise<AppResult<void>> {
		this.log.info("Converting all highlight notes to current comment style...");
		// The core logic is now a private method of this class.
		const summary = await this._convertAllToCurrentStyle();
		this.log.info(
			`Conversion complete. Scanned: ${summary.scanned}, Changed: ${summary.changed}`,
		);
		return ok(void 0);
	}

	/**
	 * Re-checks the capabilities of the device.
	 */
	async executeRecheckCapabilities(): Promise<AppResult<{ message?: string }>> {
		await this.capabilityManager.refreshAll(true);
		const message = "Capability check triggered.";
		this.log.info(message);
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
	 * Convert all highlight notes in the configured highlights folder to the
	 * current comment style defined in settings.commentStyle.
	 * Uses progress UI, supports cancellation, and runs with bounded concurrency.
	 */
	private async _convertAllToCurrentStyle(): Promise<ConversionSummary> {
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
					4,
					async (file) => {
						tick.setStatus(`Converting: ${file.name}`);
						const changed = await this._convertSingleFile(file, targetStyle);
						if (changed) summary.changed++;
						tick();
					},
					signal,
				);
			},
			{
				title: "Converting comment style",
				showWhenTotalIsZero: true,
				autoMessage: false,
			},
		);

		return summary;
	}

	private async _convertSingleFile(
		file: TFile,
		target: "html" | "md" | "none",
	): Promise<boolean> {
		try {
			// We need FrontmatterService here. We'll add it to the constructor.
			const parsed = await this.fmService.parseFile(file);
			const currentBody = parsed.body ?? "";
			const nextBody = this._convertBody(currentBody, target);
			if (nextBody === currentBody) return false;

			const res = await this.fmService.editFile(
				file,
				(doc) => ({ frontmatter: doc.frontmatter, body: nextBody }),
				{ skipIfNoChange: true, detectConcurrentModification: true },
			);
			return res.ok && res.value.changed;
		} catch (e) {
			this.log.warn(`Failed to convert ${file.path}`, e);
			return false;
		}
	}

	/**
	 * Converts all KOHL metadata comments within a note's body to the target style.
	 * This function is pure, idempotent, and safe against malformed data.
	 *
	 * @param body The raw string body of the note.
	 * @param target The desired comment style: 'html', 'md', or 'none'.
	 * @returns The transformed body content.
	 */
	private _convertBody(body: string, target: "html" | "md" | "none"): string {
		if (target === "none") {
			// If the goal is to remove comments, we can do a simple replacement
			// and then clean up any excessive newlines left behind.
			const cleaned = body.replace(ANY_KOHL_MARKER_REGEX, "");
			// Collapse 3+ newlines into a standard double newline to maintain formatting.
			return cleaned.replace(/\n\s*\n(\s*\n)+/g, "\n\n").trim();
		}

		// For 'html' or 'md' targets, we use a replacer function to process each match.
		return body.replace(ANY_KOHL_MARKER_REGEX, (match, jsonPayload: string) => {
			// Safely parse the captured JSON payload.
			const meta = safeParse<Record<string, unknown>>(jsonPayload);

			// If the JSON is malformed, return the original comment block verbatim.
			// This is a critical data-preservation step.
			if (!meta) {
				return match;
			}

			// Re-stringify the parsed metadata to ensure it's clean.
			const newJson = JSON.stringify(meta);

			// Generate the new marker in the target style.
			return target === "html"
				? `<!-- KOHL ${newJson} -->`
				: `%% KOHL ${newJson} %%`;
		});
	}
}
