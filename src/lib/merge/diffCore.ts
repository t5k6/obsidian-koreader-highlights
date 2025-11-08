import { diff3Merge, type MergeRegion } from "node-diff3";
import {
	compareAnnotations,
	getHighlightKey,
} from "src/lib/formatting/formatUtils";
import type { Annotation } from "src/types";

// Extend node-diff3's MergeRegion type to include the ok and conflict properties
declare module "node-diff3" {
	interface MergeRegion<T> {
		ok?: T[];
		conflict?: {
			a: T[];
			aIndex: number;
			b: T[];
			bIndex: number;
			o: T[];
			oIndex: number;
		};
	}
}

export function performDiff3(
	ours: string,
	base: string,
	theirs: string,
): MergeRegion<string>[] {
	return diff3Merge(ours.split("\n"), base.split("\n"), theirs.split("\n"));
}

export function formatConflictRegions(regions: MergeRegion<string>[]): {
	mergedBody: string;
	hasConflict: boolean;
} {
	const mergedLines: string[] = [];
	let hasConflict = false;
	let conflictHeaderAdded = false;

	for (const region of regions) {
		if (region.ok) {
			mergedLines.push(...region.ok);
		} else if (region.conflict) {
			hasConflict = true;
			if (!conflictHeaderAdded) {
				mergedLines.push(
					`> [!caution] Merge Conflict Detected`,
					`> This note contains conflicting changes between the version in your vault and the new version from KOReader. Please resolve the conflicts below and then remove the conflict blocks.`,
				);
				conflictHeaderAdded = true;
			}
			mergedLines.push(
				`\n> [!conflict]- Conflict Start: Your Edits (Vault)`,
				...region.conflict.a.map((line: string) => `> ${line}`),
				`> [!tip]- Incoming Changes (KOReader)`,
				...region.conflict.b.map((line: string) => `> ${line}`),
				`> [!conflict]- Conflict End`,
				`\n`,
			);
		}
	}
	return { mergedBody: mergedLines.join("\n"), hasConflict };
}

export function mergeAnnotations(
	existing: readonly Annotation[],
	incoming: readonly Annotation[],
): Annotation[] {
	const map = new Map<string, Annotation>();

	for (const ann of existing) {
		map.set(getHighlightKey(ann), ann);
	}

	for (const ann of incoming) {
		const k = getHighlightKey(ann);
		const prev = map.get(k);
		if (!prev) {
			map.set(k, ann);
		} else {
			// Create new object instead of mutating
			map.set(k, {
				...prev,
				color: prev.color ?? ann.color,
				drawer: prev.drawer ?? ann.drawer,
			});
		}
	}

	return Array.from(map.values()).sort(compareAnnotations);
}
