export type KOReaderLayout = "kobo-adds" | "generic" | "unknown";

export interface KOReaderEnvironment {
	// Validated user input
	scanPath: string;
	// Discovered
	rootPath: string | null;
	statsDbPath: string | null;
	layout: KOReaderLayout;
	// Debug/diagnostics
	discoveredBy: string; // probe name or "override"
	explain: string[]; // steps taken and why
}

export interface ProbeResult {
	rootPath: string;
	statsDbPath: string | null;
	layout: KOReaderLayout;
	explain: string[];
}
