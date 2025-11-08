import { sha1Hex } from "src/lib/core/crypto";
import { err, ok, type Result } from "src/lib/core/result";
import type { CfiParseError } from "src/lib/errors/types";
import { normalizeWhitespace } from "src/lib/strings/stringUtils";
import type { Annotation, DocProps, PositionObject } from "src/types";
import { buildNormalizedBookKey } from "./bookIdentity";

/**
 * Generates a deterministic key from document properties.
 * Used for consistent book identification across imports.
 * @param props - Document properties containing title and authors
 * @returns Normalized key in format "author::title"
 *
 * NOTE: Kept for backward compatibility. New code should use buildNormalizedBookKey.
 */
export function bookKeyFromDocProps(props: DocProps): string {
	return buildNormalizedBookKey(props);
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
 * @returns A Result containing the parsed parts or a structured error.
 */
export function parseCfi(cfi: string): Result<CfiParts, CfiParseError> {
	const match = cfi.match(CFI_REGEX_COMBINED);

	if (!match) {
		return err({ kind: "CFI_PARSE_FAILED", cfi });
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
		return err({ kind: "CFI_PARSE_FAILED", cfi });
	}

	const textNodeIndex = Number.parseInt(textNodeIndexStr, 10);
	const offset = Number.parseInt(offsetStr, 10);

	if (Number.isNaN(offset) || Number.isNaN(textNodeIndex)) {
		return err({ kind: "CFI_PARSE_FAILED", cfi });
	}

	const fullPath = `${basePath}${nodeSteps},/${textNodeIndex}`;

	return ok({
		fullPath: fullPath,
		offset: offset,
	});
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

// Helper function to extract numbers from a string for sorting
function getNumericSortKey(s: string): number[] {
	return (s.match(/\d+/g) || []).map(Number);
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

	// Secondary sort: position on page
	const posA = parsePosition(a.pos0);
	const posB = parsePosition(b.pos0);

	if (posA && posB) {
		if (posA.node !== posB.node) {
			// Compare node paths numerically first
			const keyA = getNumericSortKey(posA.node);
			const keyB = getNumericSortKey(posB.node);
			for (let i = 0; i < Math.min(keyA.length, keyB.length); i++) {
				if (keyA[i] !== keyB[i]) {
					return keyA[i] - keyB[i];
				}
			}
			// If numeric keys are same-length and equal, fall back to lexical compare
			const lenDiff = keyA.length - keyB.length;
			if (lenDiff !== 0) return lenDiff;
			return posA.node.localeCompare(posB.node);
		}
		// Tertiary sort: offset within the same node
		if (posA.offset !== posB.offset) {
			return posA.offset - posB.offset;
		}
	} else if (posA) {
		return -1; // a comes first if b has no position
	} else if (posB) {
		return 1; // b comes first if a has no position
	}

	// Fallback sort: datetime, for identical positions.
	try {
		const dateA = new Date(a.datetime).getTime();
		const dateB = new Date(b.datetime).getTime();
		if (!Number.isNaN(dateA) && !Number.isNaN(dateB)) {
			return dateA - dateB;
		}
	} catch (_e) {
		// ignore invalid date formats
	}

	return 0;
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
 * Generates a unique ID for an annotation based on its content.
 * Uses SHA1 hash of position and text data.
 * @param annotation - The annotation to generate ID for
 * @returns 16-character hex string ID
 */
export function computeAnnotationId(annotation: Annotation): string {
	const { pageno, pos0, pos1, text, note } = annotation;
	// Use the canonical normalizeWhitespace function for text and note normalization
	const normalizedText = normalizeWhitespace(text || "").toLowerCase();
	const normalizedNote = normalizeWhitespace(note || "").toLowerCase();
	const input = `${pageno}|${pos0}|${pos1}|${normalizedText}|${normalizedNote}`;
	return sha1Hex(input, { normalizeEol: true }).slice(0, 16);
}

/**
 * Gets a unique key for an annotation used for deduplication.
 * @param annotation - The annotation to get a key for
 * @returns Unique identifier string
 */
export function getHighlightKey(annotation: Annotation): string {
	return annotation.id ?? computeAnnotationId(annotation);
}
