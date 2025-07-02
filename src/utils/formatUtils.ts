import { parse } from "node:path";
import type { Annotation } from "../types";
import { devWarn } from "./logging";

const DEFAULT_AUTHOR = "Unknown Author";
const DEFAULT_TITLE = "Untitled";
const FILE_EXTENSION = ".md";
const AUTHOR_SEPARATOR = " & ";
const TITLE_SEPARATOR = " - ";

interface PositionObject {
	x: number;
	y: number;
}

interface CfiParts {
	fullPath: string; // e.g., /6/14[id6]!/4/2/6/2,/1
	offset: number;
}

// Group 1: Base path (optional, ends with !)
// Group 2: Node steps after !
// Group 3: Text node index (e.g., 1 in /1:28)
// Group 4: Start offset for pos0
// Group 5: End offset for pos0 (optional)
// OR
// Group 6: Text node index for pos1
// Group 7: End offset for pos1
const CFI_REGEX_COMBINED =
	/epubcfi\(([^!]*!)?([^,]+)(?:,\/(\d+):(\d+)(?:\,\/\d+:\d+)?)?(?:,\/(\d+):(\d+))?\)$/;

export function generateObsidianFileName(
	docProps: { title?: string; authors?: string },
	highlightsFolder: string,
	originalSdrName?: string,
	maxTotalPathLength = 255,
): string {
	const effectiveAuthor = docProps.authors?.trim();
	const effectiveTitle = docProps.title?.trim();

	let baseName: string;

	const isAuthorEffectivelyMissing =
		!effectiveAuthor || effectiveAuthor === DEFAULT_AUTHOR;

	const isTitleEffectivelyMissing =
		!effectiveTitle || effectiveTitle === DEFAULT_TITLE;

	const sdrBaseName = originalSdrName
		? normalizeFileNamePiece(getFileNameWithoutExt(originalSdrName))
		: undefined;

	if (!isAuthorEffectivelyMissing && !isTitleEffectivelyMissing) {
		// Case 1: BOTH author and title are known and not default.
		const authorArray = (effectiveAuthor || "")
			.split(",")
			.map((author) => normalizeFileNamePiece(author.trim()))
			.filter(Boolean);
		const authorsString = authorArray.join(AUTHOR_SEPARATOR);
		const normalizedTitle = normalizeFileNamePiece(effectiveTitle);
		baseName = `${authorsString}${TITLE_SEPARATOR}${normalizedTitle}`;
	} else if (!isAuthorEffectivelyMissing) {
		// Case 2: Author is known, but title is missing.
		const authorArray = (effectiveAuthor || "")
			.split(",")
			.map((author) => normalizeFileNamePiece(author.trim()))
			.filter(Boolean);
		const authorsString = authorArray.join(AUTHOR_SEPARATOR);
		const titleFallback = sdrBaseName
			? simplifySdrName(sdrBaseName)
			: DEFAULT_TITLE;
		baseName = `${authorsString}${TITLE_SEPARATOR}${titleFallback}`;
		devWarn(
			`Using filename based on author and SDR/default title: ${baseName}`,
		);
	} else if (!isTitleEffectivelyMissing) {
		// Case 3: Title is known, but author is missing.
		baseName = normalizeFileNamePiece(effectiveTitle);
		devWarn(`Using filename based on title (author missing): ${baseName}`);
	} else {
		// Case 4: BOTH are missing. Use ONLY the original SDR name (skip docProps.authors entirely).
		baseName = sdrBaseName ? simplifySdrName(sdrBaseName) : DEFAULT_TITLE;
		devWarn(`Using cleaned SDR name (author/title missing): ${baseName}`);
	}

	// Final safety net: if baseName is somehow empty, use DEFAULT_TITLE.
	if (!baseName?.trim()) {
		baseName = DEFAULT_TITLE;
		devWarn(
			`Filename defaulted to "${DEFAULT_TITLE}" due to empty base after processing.`,
		);
	}

	const FOLDER_PATH_MARGIN = highlightsFolder.length + 1 + 5;
	const maxLengthForName =
		maxTotalPathLength - FOLDER_PATH_MARGIN - FILE_EXTENSION.length;

	if (maxLengthForName <= 0) {
		devWarn(
			`highlightsFolder path is too long; falling back to default file name.`,
		);
		return DEFAULT_TITLE + FILE_EXTENSION;
	}

	let finalName = baseName;
	if (baseName.length > maxLengthForName) {
		finalName = baseName.slice(0, maxLengthForName);
		devWarn(
			`Filename truncated: "${baseName}${FILE_EXTENSION}" -> "${finalName}${FILE_EXTENSION}" due to path length constraints.`,
		);
	}

	const fullPath = `${highlightsFolder}/${finalName}${FILE_EXTENSION}`;
	devWarn(`Full path length: ${fullPath.length}, Path: ${fullPath}`);

	return `${finalName}${FILE_EXTENSION}`;
}

/**
 * Collapse all the Koreader "SDR" to something that looks like
 * a human filename.                           ─────────────────────────────
 *
 * 1.  Removes the leading "(Series-X)" block if it exists.
 * 2.  Deletes duplicate *tokens* (A – B – C – A   →   A – B – C)
 * 3.  Deletes duplicate *blocks* (A – B – C – A – B – C   →   A – B – C)
 *
 * The whole routine is case-insensitive, keeps the first spelling it
 * encounters and preserves the original " ⸺  -  " separator.
 */
export function simplifySdrName(raw: string, delimiter = " - "): string {
	if (!raw) {
		return "";
	}

	// ── 0. Strip a prepended "(……)" leader
	raw = raw.replace(/^\([^)]*\)\s*/, "").trim();

	const parts = raw
		.split(delimiter)
		.map((p) => p.trim())
		.filter(Boolean);

	// ── 1. Drop REPEATED TOKENS  (case-insensitive)
	const seen = new Set<string>();
	const uniq: string[] = [];
	for (const p of parts) {
		const key = p.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			uniq.push(p);
		}
	}

	// ── 2. Drop REPEATED BLOCKS  (A B C  A B C  →  A B C)
	let tokens = [...uniq];
	let changed = true;

	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

	while (changed) {
		changed = false;

		for (let block = Math.floor(tokens.length / 2); block >= 1; block--) {
			// slide a window over the list; whenever we see  [X…] [X…]  collapse it
			outer: for (let i = 0; i + 2 * block <= tokens.length; i++) {
				for (let j = 0; j < block; j++) {
					if (!same(tokens[i + j], tokens[i + block + j])) {
						continue outer; // not identical → keep looking
					}
				}
				// Found a duplicate block – delete the second copy
				tokens.splice(i + block, block);
				changed = true;
				break;
			}
			if (changed) break; // restart with the (possibly) shorter array
		}
	}

	return tokens.join(delimiter) || "Untitled";
}

export function normalizeFileNamePiece(
	piece: string | undefined | null,
): string {
	if (!piece) return "";
	// Remove invalid file system characters, trim, replace multiple spaces/underscores
	return piece
		.replace(/[\\/:*?"<>|#%&{}[\]]/g, "_") // More comprehensive removal list
		.replace(/\s+/g, " ") // Consolidate whitespace
		.trim();
}

export function getFileNameWithoutExt(filePath: string | undefined): string {
	if (!filePath) return "";
	return parse(filePath).name;
}

// Type guard function
function isPositionObject(obj: any): obj is PositionObject {
	return obj && typeof obj === "object" && "x" in obj && "y" in obj;
}

// Utility to parse pos0/pos1
const positionCache = new Map<string, { node: string; offset: number }>();
export function parsePosition(
	pos: string | PositionObject | undefined,
): { node: string; offset: number } | null {
	if (!pos) return null;

	// Handle the new position format with x/y coordinates
	if (isPositionObject(pos)) {
		// Create a unique identifier based on coordinates
		const node = `coord_${Math.round(pos.x)}_${Math.round(pos.y)}`;
		return { node, offset: 0 };
	}

	// Existing string parsing logic
	if (typeof pos === "string") {
		const match = pos.match(/^(.+)\.(\d+)$/);
		if (!match) return null;

		const [, node, offsetStr] = match;
		const offset = Number.parseInt(offsetStr, 10);
		return Number.isNaN(offset) ? null : { node, offset };
	}

	return null;
}

export function parseCfi(cfi: string): CfiParts | null {
	const match = cfi.match(CFI_REGEX_COMBINED);

	if (!match) {
		devWarn(`Could not parse CFI: ${cfi}`);
		return null;
	}

	const basePath = match[1] || "";
	const nodeSteps = match[2];

	let textNodeIndexStr: string | undefined;
	let offsetStr: string | undefined;

	if (match[3] !== undefined && match[4] !== undefined) {
		textNodeIndexStr = match[3];
		offsetStr = match[4];
	} else if (match[5] !== undefined && match[6] !== undefined) {
		textNodeIndexStr = match[5];
		offsetStr = match[6];
	} else {
		devWarn(`Could not determine offset structure in CFI: ${cfi}`);
		return null;
	}

	const textNodeIndex = Number.parseInt(textNodeIndexStr, 10);
	const offset = Number.parseInt(offsetStr, 10);

	if (Number.isNaN(offset) || Number.isNaN(textNodeIndex)) {
		devWarn(`Error parsing offset/text node index from CFI: ${cfi}`);
		return null;
	}

	const fullPath = `${basePath}${nodeSteps},/${textNodeIndex}`;

	return {
		fullPath: fullPath,
		offset: offset,
	};
}

export function areHighlightsSuccessive(
	h1: Annotation | undefined,
	h2: Annotation | undefined,
	maxGap = 250,
): boolean {
	if (!h1 || !h2) return false;
	if (h1.pageno !== h2.pageno) return false;

	// Handle coordinate-based positions
	if (isPositionObject(h1.pos0) && isPositionObject(h2.pos0)) {
		// Simple vertical proximity check
		return Math.abs(h1.pos0.y - h2.pos0.y) < 50;
	}

	// Existing string-based position logic
	const pos1_end = parsePosition(h1.pos1);
	const pos2_start = parsePosition(h2.pos0);

	if (!pos1_end || !pos2_start || pos1_end.node !== pos2_start.node) {
		return false;
	}

	return pos2_start.offset - pos1_end.offset <= maxGap;
}

export function compareAnnotations(a: Annotation, b: Annotation): number {
	if (!a || !b) return 0;

	// Primary sort: page number
	if (a.pageno !== b.pageno) {
		return a.pageno - b.pageno;
	}

	// Secondary sort: character position on the page.
	const posA = parsePosition(a.pos0);
	const posB = parsePosition(b.pos0);

	if (posA && posB) {
		if (posA.node !== posB.node) {
			return posA.node.localeCompare(posB.node);
		}
		if (posA.offset !== posB.offset) {
			return posA.offset - posB.offset;
		}
	} else if (posA) {
		return -1;
	} else if (posB) {
		return 1;
	}

	// Fallback sort: datetime, for identical positions.
	try {
		const dateA = new Date(a.datetime).getTime();
		const dateB = new Date(b.datetime).getTime();
		if (!Number.isNaN(dateA) && !Number.isNaN(dateB)) {
			return dateA - dateB;
		}
	} catch (e) {
		// ignore invalid date formats
	}

	return 0;
}

export function formatDate(dateStr: string): string {
	const date = new Date(dateStr);
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export function secondsToHoursMinutesSeconds(totalSeconds: number): string {
	if (totalSeconds < 0) totalSeconds = 0;

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);

	let result = "";
	if (hours > 0) {
		result += `${hours}h `;
	}
	if (minutes > 0 || hours > 0) {
		// Show minutes if hours are present or minutes > 0
		result += `${minutes}m `;
	}

	if (seconds > 0 || result === "") {
		// If result is empty, means 0h 0m, so just show seconds.
		result += `${seconds}s`;
	}

	result = result.trim(); // Remove trailing space if seconds is 0 and others are present

	return result === "" ? "0s" : result; // Handle case of exactly 0 seconds
}

export function secondsToHoursMinutes(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${minutes}m`;
}

export function formatUnixTimestamp(timestamp: number): string {
	return new Date(timestamp * 1000).toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export function formatPercent(percent: number): string {
	return `${Math.round(percent)}%`;
}

export function distanceBetweenHighlights(
	a: Annotation,
	b: Annotation,
): number {
	const posAEnd = parsePosition(a.pos1);
	const posBStart = parsePosition(b.pos0);
	if (!posAEnd || !posBStart || posAEnd.node !== posBStart.node) {
		return Infinity;
	}
	return posBStart.offset - posAEnd.offset;
}

export function isWithinGap(
	a: Annotation,
	b: Annotation,
	maxGap: number,
): boolean {
	return a.pageno === b.pageno && distanceBetweenHighlights(a, b) <= maxGap;
}
