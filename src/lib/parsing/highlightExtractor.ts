import { computeAnnotationId } from "src/lib/formatting/formatUtils";
import type { Annotation, CommentStyle, PositionObject } from "src/types";

// Pattern sources (no flags). Use [\s\S]*? to safely match multi-line JSON without dotAll.
const HTML_KOHL_PATTERN_SRC = "<!--\\s*KOHL\\s*({[\\s\\S]*?})\\s*-->";
const MD_KOHL_PATTERN_SRC = "%%\\s*KOHL\\s*({[\\s\\S]*?})\\s*%%";

// Combined pattern with named capture groups
const COMBINED_KOHL_PATTERN_SRC =
	"(?:<!--\\s*KOHL\\s*(?<html>{[\\s\\S]*?})\\s*-->)|(?:%%\\s*KOHL\\s*(?<md>{[\\s\\S]*?})\\s*%%)";

// Non-global testers for safe one-off .test() calls (no shared state)
const HTML_KOHL_TEST = new RegExp(HTML_KOHL_PATTERN_SRC);
const MD_KOHL_TEST = new RegExp(MD_KOHL_PATTERN_SRC);

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
 * First tries the preferred style, then falls back to the other if no results.
 * @param content - Content containing highlights
 * @param preferredStyle - Comment style to try first
 * @returns Array of parsed annotation objects and the style that worked
 */
export function extractHighlightsWithStyle(
	content: string,
	preferredStyle: CommentStyle,
): { annotations: Annotation[]; usedStyle: CommentStyle | null } {
	if (preferredStyle === "none") return { annotations: [], usedStyle: null };

	// Single-pass across both styles
	const combined = new RegExp(COMBINED_KOHL_PATTERN_SRC, "g");
	const allMatches = Array.from(content.matchAll(combined)) as Array<
		RegExpMatchArray & { groups?: { html?: string; md?: string } }
	>;

	if (allMatches.length === 0) return { annotations: [], usedStyle: null };

	// Summarize availability
	const htmlCount = allMatches.reduce(
		(acc, m) => acc + (m.groups?.html ? 1 : 0),
		0,
	);
	const mdCount = allMatches.length - htmlCount;

	// Decide which style to use (preserve legacy: prefer HTML when both)
	let usedStyle: CommentStyle | null = null;
	if (preferredStyle === "html" && htmlCount > 0) usedStyle = "html";
	else if (preferredStyle === "md" && mdCount > 0) usedStyle = "md";
	if (!usedStyle) {
		if (htmlCount > 0 && mdCount > 0) usedStyle = "html";
		else if (htmlCount > 0) usedStyle = "html";
		else if (mdCount > 0) usedStyle = "md";
	}
	if (!usedStyle) return { annotations: [], usedStyle: null };

	const isHtml = usedStyle === "html";

	// Filter matches to chosen style only
	const matches = allMatches
		.filter((m) => (isHtml ? !!m.groups?.html : !!m.groups?.md))
		.map((m) => ({
			index: m.index!,
			end: m.index! + m[0].length,
			json: (isHtml ? m.groups?.html : m.groups?.md) as string,
		}));

	const annotations: Annotation[] = [];

	for (let i = 0; i < matches.length; i++) {
		const meta = safeParseJson(matches[i].json);
		if (!meta || !meta.id) continue;

		const startPos = matches[i].end;
		const endPos =
			i + 1 < matches.length ? matches[i + 1].index : content.length;
		const visibleText = content.slice(startPos, endPos).trim();
		const { text, note } = splitTextAndNote(visibleText);

		annotations.push({
			id: meta.id,
			pageno: meta.p,
			pos0: meta.pos0,
			pos1: meta.pos1,
			datetime: meta.t,
			text,
			note,
		});
	}

	return { annotations, usedStyle };
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
	const hasHtml = HTML_KOHL_TEST.test(content);
	const hasMd = MD_KOHL_TEST.test(content);

	if (hasHtml && !hasMd) return "html";
	if (hasMd && !hasHtml) return "md";
	if (hasHtml && hasMd) return "html"; // legacy preference
	return null;
}

/**
 * Removes all KOHL comment markers from content.
 * @param content - Content to clean
 * @returns Content with all KOHL markers removed
 */
export function removeKohlComments(content: string): string {
	const combinedRemove = new RegExp(
		`${HTML_KOHL_PATTERN_SRC}|${MD_KOHL_PATTERN_SRC}`,
		"g",
	);
	let cleaned = content.replace(combinedRemove, "");
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
