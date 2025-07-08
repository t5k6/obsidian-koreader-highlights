import { logger } from "src/utils/logging";
import type { SDRFinder } from "./SDRFinder";

export class MountPointService {
	constructor(private readonly sdrFinder: SDRFinder) {}

	public async ensureMountPoint(): Promise<boolean> {
		const ok = await this.sdrFinder.checkMountPoint();
		if (!ok) {
			logger.warn("MountPointService: Mount point not available.");
			return false;
		}
		return true;
	}
}
