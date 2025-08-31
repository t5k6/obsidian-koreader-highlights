import { Pathing } from "src/lib/pathing";
import type { FileSystemService } from "src/services/FileSystemService";
import type { KOReaderLayout, ProbeResult } from "./types";

export interface LayoutSpec {
	readonly name: Exclude<KOReaderLayout, "unknown">;
	readonly rootMarkers: readonly string[];
	readonly statsRelPaths: readonly string[];
}

export const LAYOUT_SPECS: readonly LayoutSpec[] = [
	{
		name: "kobo-adds",
		rootMarkers: [".adds"],
		statsRelPaths: [".adds/koreader/settings/statistics.sqlite3"],
	},
	{
		name: "generic",
		rootMarkers: ["koreader"],
		statsRelPaths: ["koreader/settings/statistics.sqlite3"],
	},
] as const;

/**
 * Probes a given path against all known KOReader layouts.
 * @param fs The FileSystemService for file existence checks.
 * @param candidatePath The absolute path to check.
 * @returns A ProbeResult if a layout matches, otherwise null.
 */
export async function detectLayout(
	fs: FileSystemService,
	candidatePath: string,
): Promise<ProbeResult | null> {
	const root = Pathing.systemResolve(candidatePath);

	for (const spec of LAYOUT_SPECS) {
		const markerChecks = spec.rootMarkers.map((marker) =>
			fs.nodeFileExists(Pathing.joinSystemPath(root, marker)),
		);
		const markerExistsList = await Promise.all(markerChecks);
		const markerFoundIdx = markerExistsList.findIndex(Boolean);

		if (markerFoundIdx === -1) {
			continue;
		}

		const statsChecks = spec.statsRelPaths.map((relPath) =>
			fs.nodeFileExists(Pathing.joinSystemPath(root, relPath)),
		);
		const statsExistsList = await Promise.all(statsChecks);
		const statsFoundIdx = statsExistsList.findIndex(Boolean);
		const statsDbPath =
			statsFoundIdx >= 0
				? Pathing.joinSystemPath(root, spec.statsRelPaths[statsFoundIdx])
				: null;

		const explain = [
			`Layout [${spec.name}]: Found marker '${spec.rootMarkers[markerFoundIdx]}' in '${root}'.`,
			`Layout [${spec.name}]: Stats DB ${statsDbPath ? "found" : "not found"}.`,
		];

		return {
			rootPath: root,
			statsDbPath,
			layout: spec.name,
			explain,
		};
	}

	return null;
}
