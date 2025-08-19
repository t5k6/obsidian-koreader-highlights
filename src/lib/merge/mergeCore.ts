import { diff3Merge, type MergeRegion } from "node-diff3";
import {
	compareAnnotations,
	getHighlightKey,
} from "src/lib/formatting/formatUtils";
import type { Annotation } from "src/types";

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
		if ((region as any).ok) {
			mergedLines.push(...(region as any).ok);
		} else if ((region as any).conflict) {
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
				...((region as any).conflict.a as string[]).map((line) => `> ${line}`),
				`> [!tip]- Incoming Changes (KOReader)`,
				...((region as any).conflict.b as string[]).map((line) => `> ${line}`),
				`> [!conflict]- Conflict End`,
				`\n`,
			);
		}
	}
	return { mergedBody: mergedLines.join("\n"), hasConflict };
}

export function mergeAnnotations(
	existing: Annotation[],
	incoming: Annotation[],
): Annotation[] {
	const map = new Map(
		existing.map((ann) => [getHighlightKey(ann), ann] as const),
	);

	for (const ann of incoming) {
		const k = getHighlightKey(ann);
		const prev = map.get(k);
		if (!prev) {
			map.set(k, ann);
		} else {
			// Preserve style attributes if missing in existing
			if ((prev as any).color === undefined && (ann as any).color)
				(prev as any).color = (ann as any).color;
			if ((prev as any).drawer === undefined && (ann as any).drawer)
				(prev as any).drawer = (ann as any).drawer;
		}
	}

	return Array.from(map.values()).sort(compareAnnotations);
}
