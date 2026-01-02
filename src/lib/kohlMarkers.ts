import { safeParse } from "src/lib/core/objectUtils";
import { computeAnnotationId } from "src/lib/formatting/formatUtils";
import type { Annotation, CommentStyle } from "src/types";

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
	const meta = {
		v: 1,
		id: annotation.id ?? computeAnnotationId(annotation),
		p: annotation.pageno,
		pr: annotation.pageref,
		pos0: annotation.pos0,

		pos1: annotation.pos1,
		t: annotation.datetime,
		c: annotation.color,
		d: annotation.drawer,
	};

	// Filter out undefined keys to keep comments clean
	const cleanMeta = Object.fromEntries(
		Object.entries(meta).filter(([, v]) => v !== undefined),
	);

	const jsonMeta = JSON.stringify(cleanMeta);
	return style === "html"
		? `<!-- KOHL ${jsonMeta} -->`
		: `%% KOHL ${jsonMeta} %%`;
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
