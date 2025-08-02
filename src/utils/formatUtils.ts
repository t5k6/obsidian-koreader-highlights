import { createHash } from "node:crypto";
import { parse } from "node:path";
import type { LoggingService } from "src/services/LoggingService";
import type { Annotation } from "../types";

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
	/epubcfi\(([^!]*!)?([^,]+)(?:,\/(\d+):(\d+)(?:,\/\d+:\d+)?)?(?:,\/(\d+):(\d+))?\)$/;

/**
 * Simplifies KOReader SDR directory names to human-readable format.
 * Removes series prefixes, duplicate tokens, and duplicate blocks.
 * Case-insensitive but preserves first spelling encountered.
 *
 * Examples:
 * - "(Series-1) Title - Author - Title" → "Title - Author"
 * - "A - B - C - A - B - C" → "A - B - C"
 *
 * @param raw - The raw SDR directory name
 * @param delimiter - Separator to use (default " - ")
 * @returns Simplified filename or "Untitled" if result is empty
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
	const tokens = [...uniq];
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

	const finalName = tokens.join(delimiter);
	// If the resulting name contains no letters or numbers, it's likely not a real title.
	if (finalName && !/[a-zA-Z0-9]/.test(finalName)) {
		return "Untitled";
	}
	return finalName || "Untitled";
}

/**
 * Normalizes a string to be safe for use in filenames.
 * Removes invalid filesystem characters and cleans whitespace.
 * @param piece - String to normalize (can be null/undefined)
 * @returns Normalized string safe for filenames
 */
export function normalizeFileNamePiece(
	piece: string | undefined | null,
): string {
	if (!piece) return "";
	// Remove invalid file system characters, trim, replace multiple spaces/underscores
	return piece
		.replace(/[\\/:*?"<>|#%&{}[\]]+/g, "_")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Extracts filename without extension from a file path.
 * @param filePath - Full file path or filename
 * @returns Filename without extension, empty string if undefined
 */
export function getFileNameWithoutExt(filePath: string | undefined): string {
	if (!filePath) return "";
	return parse(filePath).name;
}

// Type guard function
function isPositionObject(obj: any): obj is PositionObject {
	return obj && typeof obj === "object" && "x" in obj && "y" in obj;
}

/**
 * Parses position data from KOReader annotations.
 * Handles both string format ("node.offset") and coordinate objects.
 * @param pos - Position data as string or coordinate object
 * @returns Parsed position with node and offset, or null if invalid
 */
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

/**
 * Parses EPUB CFI (Canonical Fragment Identifier) strings.
 * Extracts path and offset information for precise location.
 * @param cfi - The CFI string to parse
 * @returns Parsed CFI parts or null if invalid
 */
export function parseCfi(cfi: string, logger: LoggingService): CfiParts | null {
	const SCOPE = "formatUtils:CFI";
	const match = cfi.match(CFI_REGEX_COMBINED);

	if (!match) {
		logger.warn(SCOPE, `Could not parse CFI string: "${cfi}"`);
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
		logger.warn(SCOPE, `Could not determine offset structure in CFI: "${cfi}"`);
		return null;
	}

	const textNodeIndex = Number.parseInt(textNodeIndexStr, 10);
	const offset = Number.parseInt(offsetStr, 10);

	if (Number.isNaN(offset) || Number.isNaN(textNodeIndex)) {
		logger.warn(
			SCOPE,
			`Error parsing offset/text node index from CFI: "${cfi}"`,
		);
		return null;
	}

	const fullPath = `${basePath}${nodeSteps},/${textNodeIndex}`;

	return {
		fullPath: fullPath,
		offset: offset,
	};
}

/**
 * Determines if two highlights are close enough to be grouped.
 * Checks page number and position proximity.
 * @param h1 - First highlight
 * @param h2 - Second highlight
 * @param maxGap - Maximum character gap to consider successive (default 250)
 * @returns True if highlights should be grouped together
 */
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

/**
 * Comparison function for sorting annotations.
 * Sorts by: page number, position on page, then datetime.
 * @param a - First annotation
 * @param b - Second annotation
 * @returns Sort order (-1, 0, or 1)
 */
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

/**
 * Formats a percentage value.
 * @param percent - Percentage value (0-100)
 * @returns Formatted string like "75%"
 */
export function formatPercent(percent: number): string {
	return `${Math.round(percent)}%`;
}

/**
 * Calculates character distance between two highlights.
 * Used to determine if highlights should be grouped.
 * @param a - First annotation
 * @param b - Second annotation
 * @returns Character distance or Infinity if on different nodes
 */
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

/**
 * Checks if two annotations are close enough to group.
 * @param a - First annotation
 * @param b - Second annotation
 * @param maxGap - Maximum allowed character gap
 * @returns True if annotations should be grouped
 */
export function isWithinGap(
	a: Annotation,
	b: Annotation,
	maxGap: number,
): boolean {
	return a.pageno === b.pageno && distanceBetweenHighlights(a, b) <= maxGap;
}

/**
 * Calculates Levenshtein edit distance between two strings.
 * Optimized with early exit when distance exceeds max.
 * @param a - First string
 * @param b - Second string
 * @param max - Maximum distance to calculate (default 50)
 * @returns Edit distance or max+1 if exceeded
 */
export function levenshteinDistance(a: string, b: string, max = 50): number {
	if (Math.abs(a.length - b.length) > max) return max + 1; // impossible

	const aLower = a.toLowerCase();
	const bLower = b.toLowerCase();

	// classic DP but we bail out when current row min > max
	const prev = new Uint16Array(bLower.length + 1).map((_, i) => i);
	for (let i = 1; i <= aLower.length; i++) {
		prev[0] = i;
		let min = i;
		let upper = prev[0] - 1;
		for (let j = 1; j <= bLower.length; j++) {
			const cost = aLower[i - 1] === bLower[j - 1] ? 0 : 1;
			const val = Math.min(prev[j] + 1, prev[j - 1] + 1, upper + cost);
			upper = prev[j];
			prev[j] = val;
			if (val < min) min = val;
		}
		if (min > max) return max + 1; // early-exit row
	}
	return prev[bLower.length];
}

/**
 * Generates a unique ID for an annotation based on its content.
 * Uses SHA1 hash of position and text data.
 * @param annotation - The annotation to generate ID for
 * @returns 16-character hex string ID
 */
export function computeAnnotationId(annotation: Annotation): string {
	const { pageno, pos0, pos1, text } = annotation;
	const input = `${pageno}|${pos0}|${pos1}|${(text ?? "").trim()}`;
	return createHash("sha1").update(input).digest("hex").slice(0, 16);
}
