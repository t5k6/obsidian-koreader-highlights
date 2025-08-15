import { computeAnnotationId } from "src/lib/formatting/formatUtils";
import type { Annotation, CommentStyle, PositionObject } from "src/types";

// Regex pattern sources (no flags). Build instances with explicit flags where needed.
const HTML_KOHL_PATTERN_SRC = "<!--\\s*KOHL\\s*({.*?})\\s*-->";
const MD_KOHL_PATTERN_SRC = "%%\\s*KOHL\\s*({.*?})\\s*%%";

// Non-global testers for safe one-off .test() calls
const HTML_KOHL_PATTERN = new RegExp(HTML_KOHL_PATTERN_SRC);
const MD_KOHL_PATTERN = new RegExp(MD_KOHL_PATTERN_SRC);

interface KohlMetadata {
	v: number; // Version number
	id: string; // Annotation ID
	p: number; // Page number
	pos0: string | PositionObject | undefined; // Start position
	pos1: string | PositionObject | undefined; // End position
	t: string; // Datetime timestamp
}

/**
 * Safely parses JSON string without throwing errors.
 * @param json - JSON string to parse
 * @returns Parsed object or null if invalid
 */
function safeParseJson(json: string): KohlMetadata | null {
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/**
 * Splits a highlight block into text and note components.
 * Notes are identified by lines starting with ">" (markdown quotes).
 * @param block - The text block to split
 * @returns Object with text and optional note
 */
function splitTextAndNote(block: string): { text: string; note?: string } {
	const lines = block.split(/\r?\n/);
	const noteIndex = lines.findIndex((l) => l.trim().startsWith(">"));
	if (noteIndex === -1) return { text: block };
	const text = lines.slice(0, noteIndex).join("\n").trim();
	const note = lines
		.slice(noteIndex)
		.map((l) => l.replace(/^\s*>?\s*/, ""))
		.join("\n")
		.trim();
	return { text, note };
}

/**
 * Extracts highlight annotations from markdown content with fallback parsing.
 * First tries the preferred comment style, then falls back to the other style.
 * @param md - Markdown content containing highlights
 * @param preferredStyle - Comment style to try first (defaults to "html")
 * @returns Array of parsed annotation objects
 */
export function extractHighlights(
	md: string,
	preferredStyle: CommentStyle = "html",
): Annotation[] {
	const { annotations } = extractHighlightsWithStyle(md, preferredStyle);
	return annotations;
}

/**
 * Extracts highlight annotations from markdown content with fallback parsing.
 * First tries the preferred style, then falls back to the other if no results.
 * @param content - Content containing highlights
 * @param preferredStyle - Comment style to try first
 * @returns Array of parsed annotation objects and the style that worked
 */
export function extractHighlightsWithStyle(
	content: string,
	preferredStyle: CommentStyle,
): { annotations: Annotation[]; usedStyle: CommentStyle | null } {
	// If comment style is "none", don't attempt to extract any highlights
	if (preferredStyle === "none") {
		return { annotations: [], usedStyle: null };
	}

	// Try preferred style first
	const preferredRegex =
		preferredStyle === "html" ? HTML_KOHL_PATTERN : MD_KOHL_PATTERN;
	const fallbackRegex =
		preferredStyle === "html" ? MD_KOHL_PATTERN : HTML_KOHL_PATTERN;
	const fallbackStyle: CommentStyle = preferredStyle === "html" ? "md" : "html";

	let annotations = extractWithRegex(content, preferredRegex);
	if (annotations.length > 0) {
		return { annotations, usedStyle: preferredStyle };
	}

	// Try fallback style
	annotations = extractWithRegex(content, fallbackRegex);
	if (annotations.length > 0) {
		return { annotations, usedStyle: fallbackStyle };
	}

	return { annotations: [], usedStyle: null };
}

/**
 * Creates KOHL markers for multiple annotations.
 * @param annotations - Array of annotations
 * @param style - Comment style (html or md)
 * @returns Joined KOHL comment strings
 */
export function createKohlMarkers(
	annotations: Annotation[],
	style: CommentStyle,
): string {
	return annotations.map((ann) => createKohlMarker(ann, style)).join("\n");
}

/**
 * Creates a KOHL comment marker for an annotation.
 * @param annotation - The annotation to create a marker for
 * @param style - Comment style (html or md)
 * @returns KOHL comment string
 */
export function createKohlMarker(
	annotation: Annotation,
	style: CommentStyle,
): string {
	const meta: KohlMetadata = {
		v: 1,
		id: annotation.id ?? computeAnnotationId(annotation),
		p: annotation.pageno,
		pos0: annotation.pos0,
		pos1: annotation.pos1,
		t: annotation.datetime,
	};

	const jsonMeta = JSON.stringify(meta);
	return style === "html"
		? `<!-- KOHL ${jsonMeta} -->`
		: `%% KOHL ${jsonMeta} %%`;
}

/**
 * Detects which comment style is used in the given content.
 * @param content - Content to analyze
 * @returns Detected comment style or null if none found
 */
export function detectCommentStyle(content: string): CommentStyle | null {
	// Stateless tests using non-global patterns
	const hasHtml = HTML_KOHL_PATTERN.test(content);
	const hasMd = MD_KOHL_PATTERN.test(content);

	if (hasHtml && !hasMd) return "html";
	if (hasMd && !hasHtml) return "md";
	if (hasHtml && hasMd) {
		// If both exist, prefer HTML (legacy compatibility)
		return "html";
	}
	return null;
}

/**
 * Extracts highlights using a specific comment style regex.
 * @param content - Content to parse
 * @param regex - Regular expression to use for extraction
 * @returns Array of parsed annotations
 */
function extractWithRegex(content: string, pattern: RegExp): Annotation[] {
	// Create a fresh, local global regex from the source to avoid shared state.
	// Use "g" only; if JSON may span lines, swap to "gs".
	const regex = new RegExp(pattern.source, "g");
	const annotations: Annotation[] = [];
	const matches = Array.from(content.matchAll(regex));

	if (matches.length === 0) {
		return [];
	}

	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		const meta = safeParseJson(match[1]);
		if (!meta || !meta.id) continue;

		const startPos = match.index! + match[0].length;
		const endPos = matches[i + 1] ? matches[i + 1].index! : content.length;
		const visibleText = content.slice(startPos, endPos).trim();
		const { text, note } = splitTextAndNote(visibleText);

		annotations.push({
			id: meta.id,
			pageno: meta.p,
			pos0: meta.pos0,
			pos1: meta.pos1,
			datetime: meta.t,
			text: text,
			note: note,
		});
	}
	return annotations;
}

/**
 * Removes all KOHL comment markers from content.
 * @param content - Content to clean
 * @returns Content with all KOHL markers removed
 */
export function removeKohlComments(content: string): string {
	// Use local, stateful regex instances built from sources
	let cleaned = content.replace(new RegExp(HTML_KOHL_PATTERN_SRC, "g"), "");
	cleaned = cleaned.replace(new RegExp(MD_KOHL_PATTERN_SRC, "g"), "");

	// Collapse 3+ blank lines down to 2
	cleaned = cleaned.replace(/\n\s*\n(\s*\n)+/g, "\n\n");

	return cleaned;
}

/**
 * Converts content from one comment style to another.
 * @param content - Content to convert
 * @param fromStyle - Current comment style
 * @param toStyle - Target comment style
 * @returns Converted content
 */
export function convertCommentStyle(
	content: string,
	fromStyle: CommentStyle,
	toStyle: CommentStyle,
): string {
	if (fromStyle === toStyle) return content;

	if (toStyle === "none") {
		return removeKohlComments(content);
	}

	if (fromStyle === "none") {
		return content; // No comments to convert from
	}

	const fromPattern =
		fromStyle === "html" ? HTML_KOHL_PATTERN_SRC : MD_KOHL_PATTERN_SRC;
	const fromRegex = new RegExp(fromPattern, "g");

	return content.replace(fromRegex, (match, jsonMeta) => {
		const meta = safeParseJson(jsonMeta);
		if (!meta) return match; // Keep original if can't parse

		const newJsonMeta = JSON.stringify(meta);
		return toStyle === "html"
			? `<!-- KOHL ${newJsonMeta} -->`
			: `%% KOHL ${newJsonMeta} %%`;
	});
}
