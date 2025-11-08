import type { TFile } from "obsidian";
import type {
	Annotation,
	DocProps,
	DuplicateMatch,
	LuaMetadata,
} from "src/types";
import { bookKeyFromDocProps, getHighlightKey } from "./formatting";
import { Pathing } from "./pathing";

export type DuplicateCounts = {
	newHighlights: number;
	modifiedHighlights: number;
	matchType: DuplicateMatch["matchType"];
};

/**
 * Builds a set of pre-calculated, normalized keys from DocProps for efficient filename matching.
 * This is a "Shell" responsibility to prepare data for the pure "Core".
 */
export function buildExpectedFilenameKeys(docProps: DocProps): Set<string> {
	const keys = new Set<string>();
	const title = docProps.title ?? "";
	const authors = docProps.authors ?? "";

	if (title) keys.add(Pathing.toMatchKey(title));
	if (authors) keys.add(Pathing.toMatchKey(authors));

	if (title && authors) {
		keys.add(Pathing.toMatchKey(`${title} ${authors}`));
		keys.add(Pathing.toMatchKey(`${authors} ${title}`));
		keys.add(Pathing.toMatchKey(`${title} - ${authors}`));
		keys.add(Pathing.toMatchKey(`${authors} - ${title}`));
	}

	return keys;
}

/**
 * Check if a filename matches expected keys
 */
export function filenameMatchesKeys(
	basename: string, // This is the full filename, e.g., "My Book.md"
	expectedKeys: Set<string>,
): boolean {
	const stemWithMetadata = Pathing.getFileNameWithoutExt(basename);
	// Then, strip any trailing metadata like [tags] or (notes) before matching.
	const stem = stemWithMetadata.replace(
		/(?:\s*(?:\[[^\]]*]|\([^)]*\)))+$/g,
		"",
	);
	const key = Pathing.toMatchKey(stem);
	return expectedKeys.has(key);
}

export function isPotentialMatch(
	frontmatter: { title?: string; authors?: string | string[] } | undefined,
	basename: string,
	bookKey: string,
	expectedFilenameKeys: Set<string>,
): boolean {
	// A file is a potential match if its frontmatter matches OR its filename matches.
	// Ensure frontmatter is checked first as it's more reliable.
	if (frontmatter) {
		const fmBookKey = bookKeyFromDocProps({
			title: frontmatter.title ?? "",
			authors: Array.isArray(frontmatter.authors)
				? frontmatter.authors.join(", ")
				: (frontmatter.authors ?? ""),
		});
		if (fmBookKey === bookKey) return true;
	}
	return filenameMatchesKeys(basename, expectedFilenameKeys);
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
			const prevNormText = Pathing.normalizeWhitespace(
				prev.text ?? "",
			).toLowerCase();
			const incNormText = Pathing.normalizeWhitespace(
				n.text ?? "",
			).toLowerCase();

			const prevNormNote = Pathing.normalizeWhitespace(
				prev.note ?? "",
			).toLowerCase();
			const incNormNote = Pathing.normalizeWhitespace(
				n.note ?? "",
			).toLowerCase();

			if (prevNormText !== incNormText || prevNormNote !== incNormNote) {
				modifiedCount++;
			}
		}
	}

	return {
		newHighlights: newCount,
		modifiedHighlights: modifiedCount,
		matchType: classifyMatchType(newCount, modifiedCount),
	};
}

/**
 * Pure sorter for DuplicateMatch[] with a stable policy:
 * 1) matchType: exact > updated > divergent (best to worst)
 * 2) modifiedHighlights (ascending)
 * 3) newHighlights (ascending)
 * 4) prefer in highlights folder
 * 5) newest mtime (descending)
 */
export function sortDuplicateMatches(
	matches: DuplicateMatch[],
	highlightsFolder: string,
): DuplicateMatch[] {
	if (matches.length === 0) return [];

	const folder = (highlightsFolder ?? "").replace(/\/+$/, "");
	const inFolder = (p: string): boolean => {
		if (!p) return false;
		if (!folder) {
			// If no folder is set, prefer root-level files.
			return !p.includes("/");
		}
		return p.startsWith(`${folder}/`);
	};

	// Establish a clear, semantic ranking for match types. Lower is better.
	const typeRank = (t: DuplicateMatch["matchType"]): number => {
		switch (t) {
			case "exact":
				return 0; // Best
			case "updated":
				return 1;
			case "divergent":
				return 2; // Worst
			default:
				return 3;
		}
	};

	return [...matches].sort((a, b) => {
		// Criterion 1: Match type (best to worst)
		const rankComparison = typeRank(a.matchType) - typeRank(b.matchType);
		if (rankComparison !== 0) return rankComparison;

		// Criterion 2: Fewer modified highlights is better
		const modifiedComparison = a.modifiedHighlights - b.modifiedHighlights;
		if (modifiedComparison !== 0) return modifiedComparison;

		// Criterion 3: Fewer new highlights is better
		const newComparison = a.newHighlights - b.newHighlights;
		if (newComparison !== 0) return newComparison;

		// Criterion 4: Prefer files inside the highlights folder
		const aInFolder = inFolder(a.file.path) ? 0 : 1;
		const bInFolder = inFolder(b.file.path) ? 0 : 1;
		const folderComparison = aInFolder - bInFolder;
		if (folderComparison !== 0) return folderComparison;

		// Criterion 5: Newest file first.
		// Be defensive: some callers/tests may accidentally include entries without a file.
		if (!a.file && !b.file) return 0;
		if (!a.file) return 1;
		if (!b.file) return -1;

		const aMtime = a.file.stat?.mtime ?? 0;
		const bMtime = b.file.stat?.mtime ?? 0;
		return bMtime - aMtime;
	});
}

// This pure factory takes the results of I/O, not the services that perform it.
export function createDuplicateMatch(
	existingFile: TFile,
	existingAnnotations: Annotation[],
	newAnnotations: Annotation[],
	luaMetadata: LuaMetadata,
	canMergeSafely: boolean,
	expectedUid?: string,
): DuplicateMatch {
	const { newHighlights, modifiedHighlights, matchType } = analyzeAnnotations(
		existingAnnotations,
		newAnnotations,
	);
	return {
		file: existingFile,
		matchType,
		newHighlights,
		modifiedHighlights,
		luaMetadata,
		expectedUid,
		canMergeSafely,
	};
}
