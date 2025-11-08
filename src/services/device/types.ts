// Lightweight environment surface for UI validation
export interface DeviceEnvironment {
	scanPath: string;
	statsDbPath: string | null;
	isValid: boolean;
}
