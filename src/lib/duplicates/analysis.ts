import { getHighlightKey } from "src/lib/formatting/formatUtils";
import { normalizeWhitespace } from "src/lib/strings/stringUtils";
import type { Annotation, DuplicateMatch } from "src/types";

export type DuplicateCounts = {
	newHighlights: number;
	modifiedHighlights: number;
	matchType: DuplicateMatch["matchType"];
};

function normalizeForComparison(text?: string): string {
	return normalizeWhitespace(text || "").toLowerCase() ?? "";
}

export function classifyMatchType(
	newCount: number,
	modifiedCount: number,
): DuplicateMatch["matchType"] {
	if (newCount === 0 && modifiedCount === 0) return "exact";
	if (modifiedCount > 0) return "divergent";
	return "updated";
}

/**
 * Pure diffing of annotations. No I/O, no Obsidian types.
 */
export function analyzeAnnotations(
	existing: Annotation[],
	incoming: Annotation[],
): DuplicateCounts {
	let newCount = 0;
	let modifiedCount = 0;

	const byKey = new Map<string, Annotation>(
		existing.map((h) => [getHighlightKey(h), h]),
	);

	for (const n of incoming) {
		const k = getHighlightKey(n);
		const prev = byKey.get(k);
		if (!prev) {
			newCount++;
		} else {
			const textModified =
				normalizeForComparison(prev.text) !== normalizeForComparison(n.text);
			const noteModified =
				normalizeForComparison(prev.note) !== normalizeForComparison(n.note);
			if (textModified || noteModified) modifiedCount++;
		}
	}

	return {
		newHighlights: newCount,
		modifiedHighlights: modifiedCount,
		// Pass the new arguments to the updated function.
		matchType: classifyMatchType(newCount, modifiedCount),
	};
}

/**
 * Pure sorter for DuplicateMatch[] with a stable policy:
 * 1) matchType: exact > divergent > updated
 * 2) modifiedHighlights (asc)
 * 3) newHighlights (asc)
 * 4) prefer in highlights folder
 * 5) newest mtime
 */
export function sortDuplicateMatches(
	matches: DuplicateMatch[],
	highlightsFolder: string,
): DuplicateMatch[] {
	const folder = (highlightsFolder ?? "").replace(/\/+$/, ""); // normalize trailing slash
	const inFolder = (p: string) =>
		folder
			? p.startsWith(folder + "/")
			: p.length > 0
				? !p.includes("/")
				: true;

	const rank = (t: DuplicateMatch["matchType"]) =>
		(({ exact: 0, divergent: 1, updated: 2 }) as const)[t] ?? 3;

	return [...matches].sort((a, b) => {
		const t1 = rank(a.matchType) - rank(b.matchType);
		if (t1 !== 0) return t1;

		const t2 = a.modifiedHighlights - b.modifiedHighlights;
		if (t2 !== 0) return t2;

		const t3 = a.newHighlights - b.newHighlights;
		if (t3 !== 0) return t3;

		const aIn = inFolder(a.file.path) ? 0 : 1;
		const bIn = inFolder(b.file.path) ? 0 : 1;
		const t4 = aIn - bIn;
		if (t4 !== 0) return t4;

		const am = a.file.stat.mtime ?? 0;
		const bm = b.file.stat.mtime ?? 0;
		return bm - am;
	});
}
