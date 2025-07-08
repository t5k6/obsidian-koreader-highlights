import { type App, Notice, TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { ProgressModal } from "src/ui/ProgressModal";
import {
	ensureParentDirectory,
	generateUniqueFilePath,
} from "src/utils/fileUtils";
import { logger } from "src/utils/logging";
import type { SDRFinder } from "./SDRFinder";

export class ScanManager {
	private static readonly SCAN_REPORT_FILENAME = "KOReader SDR Scan Report.md";

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private sdrFinder: SDRFinder,
	) {}

	async scanForHighlights(): Promise<void> {
		logger.info("ScanManager: Starting KOReader SDR scan process...");

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
				logger.info("ScanManager: Scan complete. No SDR files found.");
				modal.close();
				await this.createOrUpdateScanNote([]);
				return;
			}

			logger.info(
				`ScanManager: Scan found ${sdrFilePaths.length} SDR directories.`,
			);
			modal.statusEl.setText(
				`Found ${sdrFilePaths.length} files. Generating report...`,
			);

			await this.createOrUpdateScanNote(sdrFilePaths);

			new Notice(
				`Scan complete: Report saved to "${ScanManager.SCAN_REPORT_FILENAME}"`,
			);
			logger.info("ScanManager: Scan process finished successfully.");
		} catch (error) {
			logger.error("ScanManager: Error during SDR scan process:", error);
			new Notice(
				"KOReader Importer: Error during scan. Check console for details.",
			);
		} finally {
			modal.close();
		}
	}

	private async createOrUpdateScanNote(sdrFilePaths: string[]): Promise<void> {
		const reportFolderName = this.plugin.settings.highlightsFolder;
		const uniqueReportPath = await generateUniqueFilePath(
			this.app.vault,
			reportFolderName,
			ScanManager.SCAN_REPORT_FILENAME,
		);

		const reportContent = this.generateReportContent(sdrFilePaths);

		try {
			await ensureParentDirectory(this.app.vault, uniqueReportPath);
			const existingReportFile =
				this.app.vault.getAbstractFileByPath(uniqueReportPath);

			if (existingReportFile instanceof TFile) {
				logger.info(
					`ScanManager: Updating existing scan report: ${uniqueReportPath}`,
				);
				await this.app.vault.modify(existingReportFile, reportContent);
			} else {
				logger.info(
					`ScanManager: Creating new scan report: ${uniqueReportPath}`,
				);
				await this.app.vault.create(uniqueReportPath, reportContent);
			}
		} catch (error) {
			logger.error(
				`ScanManager: Error creating/updating scan report note at ${uniqueReportPath}:`,
				error,
			);
			new Notice("Failed to save scan report note.");
			throw error;
		}
	}

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
