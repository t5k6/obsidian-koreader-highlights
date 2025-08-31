import type { SimpleCache } from "src/lib/cache";
import { sha1Hex } from "src/lib/core/crypto";
import { safeParse } from "src/lib/core/validationUtils";
import type { Annotation, CommentStyle, PositionObject } from "src/types";

// Canonical KOHL marker pattern: matches HTML or MD markers and captures the JSON payload.
// Use [\s\S]*? to match multiline JSON in a non-greedy way.
export const ANY_KOHL_MARKER_PATTERN_SRC =
	"(?:<!--|%%)\\s*KOHL\\s*({[\\s\\S]*?})\\s*(?:-->|%%)";

// Global version for replace/find-all. Beware: global regexes are stateful.
export const ANY_KOHL_MARKER_REGEX = new RegExp(
	ANY_KOHL_MARKER_PATTERN_SRC,
	"g",
);

// Non-global tester for safe presence checks when needed.
export const ANY_KOHL_MARKER_TEST = new RegExp(ANY_KOHL_MARKER_PATTERN_SRC);

// Utility for callers who want a fresh instance (avoids shared lastIndex).
export const makeAnyKohlRegex = (flags = "g") =>
	new RegExp(ANY_KOHL_MARKER_PATTERN_SRC, flags);

// Infer style from a matched marker block.
function inferStyleFromBlock(block: string): "html" | "md" {
	// Fast and robust: the block starts with either "<!--" or "%%"
	return block.startsWith("<!--") ? "html" : "md";
}

interface KohlMetadata {
	v: number; // Version number
	id: string; // Annotation ID
	p: number; // Page number
	pos0: string | PositionObject | undefined; // Start position
	pos1: string | PositionObject | undefined; // End position
	t: string; // Datetime timestamp
}

type Style = Extract<CommentStyle, "html" | "md">;

type Marker = {
	style: Style;
	index: number;
	end: number;
	json: string;
};

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
 * @param options - Optional configuration including cache
 * @returns Array of parsed annotation objects and the style that worked
 */
export function extractHighlightsWithStyle(
	content: string,
	preferredStyle: CommentStyle,
	options?: { cache?: SimpleCache<string, ScanResult> },
): {
	annotations: Annotation[];
	usedStyle: CommentStyle | null;
	hasMixedStyles: boolean;
	skippedCount: number;
} {
	if (preferredStyle === "none") {
		return {
			annotations: [],
			usedStyle: null,
			hasMixedStyles: false,
			skippedCount: 0,
		};
	}

	const { markers: allMarkers, styles } = scanAllCached(content, options);
	if (allMarkers.length === 0) {
		return {
			annotations: [],
			usedStyle: null,
			hasMixedStyles: false,
			skippedCount: 0,
		};
	}
	const hasMixedStyles = styles.size > 1;
	const usedStyle = chooseStyle(preferredStyle as Style, allMarkers);
	if (!usedStyle) {
		return {
			annotations: [],
			usedStyle: null,
			hasMixedStyles,
			skippedCount: 0,
		};
	}

	const annotations: Annotation[] = [];
	let skippedCount = 0;

	for (let i = 0; i < allMarkers.length; i++) {
		const m = allMarkers[i];

		if (m.style !== usedStyle) continue;

		const meta = safeParse<KohlMetadata & Record<string, any>>(m.json) as any;
		if (!meta || !meta.id) {
			skippedCount++;
			continue;
		}

		const startPos = m.end;
		const endPos =
			i + 1 < allMarkers.length ? allMarkers[i + 1].index : content.length;

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
			color: meta.c,
			drawer: meta.d,
		});
	}

	return { annotations, usedStyle, hasMixedStyles, skippedCount };
}

/**
 * Extracts highlights by auto-detecting the comment style from the content.
 * @param content - The note body to parse.
 * @param options - Optional configuration including cache.
 * @returns The result of the extraction, including the detected style.
 */
export function extractHighlightsAuto(
	content: string,
	options?: { cache?: SimpleCache<string, ScanResult> },
): {
	annotations: Annotation[];
	usedStyle: CommentStyle | null;
	hasMixedStyles: boolean;
	skippedCount: number;
} {
	const detectedStyle = detectCommentStyle(content);
	// Fallback to 'html' is safe; extractHighlightsWithStyle will then
	// correctly handle finding 'md' markers if no 'html' markers are present.
	const parseStyle = detectedStyle ?? "html";
	return extractHighlightsWithStyle(content, parseStyle, options);
}

/**
 * Detects which comment style is used in the given content.
 * @param content - Content to analyze
 * @returns Detected comment style or null if none found
 */
export function detectCommentStyle(content: string): CommentStyle | null {
	const re = makeAnyKohlRegex("g");
	let hasHtml = false;
	let hasMd = false;

	for (const m of content.matchAll(re)) {
		const block = m[0] as string;
		const style = inferStyleFromBlock(block);
		if (style === "html") hasHtml = true;
		else hasMd = true;
		if (hasHtml && hasMd) break;
	}

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
	const cleaned = content.replace(ANY_KOHL_MARKER_REGEX, "");
	return cleaned.replace(/\n\s*\n(\s*\n)+/g, "\n\n");
}

/**
 * Converts all KOHL metadata comments within a note's body to the target style.
 * This function is pure, idempotent, and safe against malformed data.
 * It is the single source of truth for comment style conversion.
 *
 * @param content The raw string content of the note body.
 * @param targetStyle The desired comment style: 'html', 'md', or 'none'.
 * @returns The transformed body content.
 */
export function convertKohlMarkers(
	content: string,
	targetStyle: CommentStyle,
): string {
	if (targetStyle === "none") {
		// Delegate to the dedicated removal function for clarity.
		return removeKohlComments(content);
	}

	if (targetStyle !== "html" && targetStyle !== "md") {
		return content; // Return original content if target is invalid.
	}

	// Use a replacer function to process each match safely.
	return content.replace(
		ANY_KOHL_MARKER_REGEX,
		(match, jsonPayload: string) => {
			// Safely parse the captured JSON payload.
			const meta = safeParse<Record<string, unknown>>(jsonPayload);

			// If the JSON is malformed, return the original comment block verbatim.
			// This is a critical data-preservation step.
			if (!meta) {
				return match;
			}

			// Re-stringify the parsed metadata to ensure it's clean and canonical.
			const newJson = JSON.stringify(meta);

			// Generate the new marker in the target style.
			return targetStyle === "html"
				? `<!-- KOHL ${newJson} -->`
				: `%% KOHL ${newJson} %%`;
		},
	);
}

type ScanResult = { markers: Marker[]; styles: Set<Style> };

export function scanAllCached(
	content: string,
	options?: { cache?: SimpleCache<string, ScanResult> },
): ScanResult {
	const cache = options?.cache;
	const key =
		content.length <= 8192
			? `s:${content}`
			: `h:${sha1Hex(content, { normalizeEol: true })}`;

	if (cache) {
		const cached = cache.get(key);
		if (cached) return cached;
	}

	const re = makeAnyKohlRegex("g");
	const markers: Marker[] = [];
	for (const m of content.matchAll(re)) {
		const index = (m as RegExpMatchArray).index!;
		const block = m[0] as string;
		const json = m[1] as string;
		const style = inferStyleFromBlock(block);
		markers.push({ style, index, end: index + block.length, json });
	}

	markers.sort((a, b) => a.index - b.index || (a.style < b.style ? -1 : 1));
	const result = {
		markers,
		styles: new Set<Style>(markers.map((m) => m.style)),
	};

	cache?.set(key, result);
	return result;
}

function chooseStyle(preferred: Style, markers: Marker[]): Style | null {
	const present = new Set<Style>(markers.map((m) => m.style));
	if (present.has(preferred)) return preferred;
	const fallback: Style = preferred === "html" ? "md" : "html";
	return present.has(fallback) ? fallback : null;
}
