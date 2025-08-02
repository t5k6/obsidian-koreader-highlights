import { type App, Notice, TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { ProgressModal } from "src/ui/ProgressModal";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { SDRFinder } from "./SDRFinder";

export class ScanManager {
	private static readonly SCAN_REPORT_FILENAME = "KOReader SDR Scan Report.md";
	private readonly SCOPE = "ScanManager";

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private sdrFinder: SDRFinder,
		private fs: FileSystemService,
		private loggingService: LoggingService,
	) {}

	/**
	 * Performs a scan for KOReader highlight files without importing.
	 * Creates a report showing what files would be processed.
	 * Useful for debugging and verifying settings.
	 */
	async scanForHighlights(): Promise<void> {
		this.loggingService.info(
			this.SCOPE,
			"Starting KOReader SDR scan process...",
		);

		const modal = new ProgressModal(this.app);
		modal.open();
		modal.statusEl.setText("Scanning for KOReader highlight files...");

		try {
			const sdrFilePaths =
				await this.sdrFinder.findSdrDirectoriesWithMetadata();

			if (!sdrFilePaths || sdrFilePaths.length === 0) {
				new Notice(
					"Scan complete: No KOReader highlight files (.sdr directories with metadata.lua) found.",
				);
				this.loggingService.info(
					this.SCOPE,
					"Scan complete. No SDR files found.",
				);
				modal.close();
				await this.createOrUpdateScanNote([]);
				return;
			}

			this.loggingService.info(
				this.SCOPE,
				`Scan found ${sdrFilePaths.length} SDR directories.`,
			);
			modal.statusEl.setText(
				`Found ${sdrFilePaths.length} files. Generating report...`,
			);

			await this.createOrUpdateScanNote(sdrFilePaths);

			new Notice(
				`Scan complete: Report saved to "${ScanManager.SCAN_REPORT_FILENAME}"`,
			);
			this.loggingService.info(
				this.SCOPE,
				"Scan process finished successfully.",
			);
		} catch (error) {
			this.loggingService.error(
				this.SCOPE,
				"Error during SDR scan process:",
				error,
			);
			new Notice(
				"KOReader Importer: Error during scan. Check console for details.",
			);
		} finally {
			modal.close();
		}
	}

	/**
	 * Creates or updates the scan report file in the vault.
	 * @param sdrFilePaths - Array of SDR directory paths found
	 */
	private async createOrUpdateScanNote(sdrFilePaths: string[]): Promise<void> {
		// 1. Define the constant file path components
		const reportFilename = ScanManager.SCAN_REPORT_FILENAME; // "KOReader SDR Scan Report.md"
		const reportFolderPath = this.plugin.settings.highlightsFolder;
		const fullReportPath = `${reportFolderPath}/${reportFilename}`;

		// 2. Generate the content you intend to write
		const reportContent = this.generateReportContent(sdrFilePaths);

		try {
			// 3. Check if the file already exists in the vault
			const existingReportFile =
				this.app.vault.getAbstractFileByPath(fullReportPath);

			if (existingReportFile instanceof TFile) {
				// 4. If it exists, MODIFY it with the new content
				this.loggingService.info(
					this.SCOPE,
					`Updating existing scan report: ${fullReportPath}`,
				);
				await this.app.vault.modify(existingReportFile, reportContent);
			} else {
				// 5. If it does NOT exist, CREATE it.
				// First, ensure the parent directory exists.
				await this.fs.ensureVaultFolder(reportFolderPath);

				this.loggingService.info(
					this.SCOPE,
					`Creating new scan report: ${fullReportPath}`,
				);
				await this.app.vault.create(fullReportPath, reportContent);
			}
		} catch (error) {
			this.loggingService.error(
				this.SCOPE,
				`Error creating/updating scan report note at ${fullReportPath}:`,
				error,
			);
			new Notice("Failed to save scan report note.");
			throw error;
		}
	}

	/**
	 * Generates the markdown content for the scan report.
	 * @param sdrFilePaths - Array of SDR directory paths found
	 * @returns Formatted markdown report content
	 */
	private generateReportContent(sdrFilePaths: string[]): string {
		const timestamp = new Date().toLocaleString();
		let content = "# KOReader SDR Scan Report\n\n";
		content += `*Scan performed on: ${timestamp}*\n`;
		content += `*Mount Point: ${this.plugin.settings.koreaderMountPoint}*\n\n`;

		if (sdrFilePaths.length === 0) {
			content +=
				"No `.sdr` directories containing `metadata.*.lua` files were found matching the current settings.\n";
		} else {
			content += `Found ${sdrFilePaths.length} ".sdr" directories with metadata:\n\n`;
			content += sdrFilePaths
				.map(
					(filePath) =>
						`- \`${filePath.replace(this.plugin.settings.koreaderMountPoint, "")}\``,
				) // Show relative path from mount point
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
}
