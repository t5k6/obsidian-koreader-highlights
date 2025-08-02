import { Notice } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { LoggingService } from "../LoggingService";
import type { SDRFinder } from "./SDRFinder";

export class MountPointService {
	private readonly SCOPE = "MountPointService";
	constructor(
		private readonly plugin: KoreaderImporterPlugin,
		private readonly sdrFinder: SDRFinder,
		private readonly loggingService: LoggingService,
	) {}

	/**
	 * Ensures the KOReader mount point is accessible.
	 * Used to validate configuration before attempting operations.
	 * @returns True if mount point is accessible, false otherwise
	 */
	public async ensureMountPoint(): Promise<boolean> {
		const { isReady, autoDetectedPath } =
			await this.sdrFinder.checkMountPoint();
		if (autoDetectedPath) {
			this.plugin.settings.koreaderMountPoint = autoDetectedPath;
			// The saveSettings call will notify all other services of the change.
			await this.plugin.saveSettings();
			new Notice(
				`KOReader: Auto-detected device at "${autoDetectedPath}"`,
				5_000,
			);
			return true;
		}

		if (!isReady) {
			this.loggingService.warn(this.SCOPE, "Mount point not available.");
			return false;
		}

		return true;
	}
}
