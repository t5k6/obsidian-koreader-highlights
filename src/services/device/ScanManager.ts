import path from "node:path";
import { type App, Notice } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { ProgressModal } from "src/ui/ProgressModal";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { SDRFinder } from "./SDRFinder";

export class ScanManager {
	private static readonly SCAN_REPORT_FILENAME = "KOReader SDR Scan Report.md";
	private readonly log;

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private sdrFinder: SDRFinder,
		private fs: FileSystemService,
		private loggingService: LoggingService,
	) {
		this.log = this.loggingService.scoped("ScanManager");
	}

	/**
	 * Performs a scan for KOReader highlight files without importing.
	 * Creates a report showing what files would be processed.
	 * Useful for debugging and verifying settings.
	 */
	async scanForHighlights(): Promise<void> {
		this.log.info("Starting KOReader SDR scan process...");

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
				this.log.info("Scan complete. No SDR files found.");
				modal.close();
				await this.createOrUpdateScanNote([]);
				return;
			}

			this.log.info(`Scan found ${sdrFilePaths.length} metadata files.`);
			modal.statusEl.setText(
				`Found ${sdrFilePaths.length} files. Generating report...`,
			);

			await this.createOrUpdateScanNote(sdrFilePaths);

			new Notice(
				`Scan complete: Report saved to "${ScanManager.SCAN_REPORT_FILENAME}"`,
			);
			this.log.info("Scan process finished successfully.");
		} catch (error) {
			this.log.error("Error during SDR scan process:", error);
			new Notice(
				"KOReader Importer: Error during scan. Check console for details.",
			);
		} finally {
			modal.close();
		}
	}

	/**
	 * Creates or updates the scan report file in the vault.
	 * @param sdrFilePaths - Array of metadata file paths found
	 */
	private async createOrUpdateScanNote(sdrFilePaths: string[]): Promise<void> {
		const reportFilename = ScanManager.SCAN_REPORT_FILENAME;
		const reportFolderPath = this.plugin.settings.highlightsFolder;
		const fullReportPath = `${reportFolderPath}/${reportFilename}`;

		const reportContent = this.generateReportContent(sdrFilePaths);

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
				"No `.sdr` metadata files (`metadata.*.lua`) were found matching the current settings.\n";
		} else {
			content += `Found ${sdrFilePaths.length} metadata files:\n\n`;
			content += sdrFilePaths
				.map((metadataFilePath) => {
					const mountPoint = this.plugin.settings.koreaderMountPoint;
					// Generate a relative path and ensure it uses forward slashes
					const relativePath = path
						.relative(mountPoint, metadataFilePath)
						.replace(/\\/g, "/");
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
}
