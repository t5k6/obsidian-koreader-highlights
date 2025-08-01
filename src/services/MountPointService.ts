import { logger } from "src/utils/logging";
import type { SDRFinder } from "./SDRFinder";

export class MountPointService {
	constructor(private readonly sdrFinder: SDRFinder) {}

	/**
	 * Ensures the KOReader mount point is accessible.
	 * Used to validate configuration before attempting operations.
	 * @returns True if mount point is accessible, false otherwise
	 */
	public async ensureMountPoint(): Promise<boolean> {
		const ok = await this.sdrFinder.checkMountPoint();
		if (!ok) {
			logger.warn("MountPointService: Mount point not available.");
			return false;
		}
		return true;
	}
}
