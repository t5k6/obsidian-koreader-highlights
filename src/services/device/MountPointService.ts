import type { LoggingService } from "../LoggingService";
import type { SDRFinder } from "./SDRFinder";

export class MountPointService {
	private readonly SCOPE = "MountPointService";
	constructor(
		private readonly sdrFinder: SDRFinder,
		private readonly loggingService: LoggingService,
	) {}

	/**
	 * Ensures the KOReader mount point is accessible.
	 * Used to validate configuration before attempting operations.
	 * @returns True if mount point is accessible, false otherwise
	 */
	public async ensureMountPoint(): Promise<boolean> {
		const ok = await this.sdrFinder.checkMountPoint();
		if (!ok) {
			this.loggingService.warn(this.SCOPE, "Mount point not available.");
			return false;
		}
		return true;
	}
}
