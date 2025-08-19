/**
 * Domain-agnostic string manipulation primitives.
 *
 * This module contains universal string building blocks that operate on raw JavaScript types
 * and have no knowledge of application-specific types like Annotation, DocProps, or LuaMetadata.
 * Functions here could theoretically be published as standalone micro-libraries.
 */

/**
 * HTML entity mappings for escaping.
 */
export const htmlEntities: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/**
 * Escapes HTML special characters in a string.
 * Converts characters that have special meaning in HTML to their entity equivalents.
 *
 * @param s - The string to escape
 * @returns The HTML-escaped string
 */
export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => htmlEntities[c]!);
}

/**
 * Removes HTML tags from a string after decoding common entities.
 * First decodes entity-encoded tags like &lt;h1&gt; to prevent reintroduction,
 * then strips all HTML tags.
 *
 * @param s - The string to strip HTML from
 * @returns The string with HTML tags removed
 */
export function stripHtml(s: string): string {
	const decoded = s.replace(
		/&(?:amp|lt|gt|quot|#39);/g,
		(m) =>
			(
				({
					"&amp;": "&",
					"&lt;": "<",
					"&gt;": ">",
					"&quot;": '"',
					"&#39;": "'",
				}) as const
			)[m]!,
	);
	return decoded.replace(/<[^>]*>/g, "");
}

/**
 * Normalizes whitespace in a string by trimming and collapsing multiple whitespace
 * characters (including Unicode whitespace) into single spaces.
 *
 * @param s - The string to normalize
 * @returns The string with normalized whitespace
 */
export function normalizeWhitespace(s: string): string {
	return String(s).trim().replace(/\s+/g, " ");
}

/**
 * Strips combining diacritical marks from a string after Unicode normalization.
 * Useful for creating ASCII-compatible versions of text while preserving base characters.
 *
 * @param s - The string to strip diacritics from
 * @returns The string with diacritical marks removed
 */
export function stripDiacritics(s: string): string {
	return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Splits a string by a separator and trims each part, filtering out empty strings.
 * Useful for parsing comma-separated lists or similar delimited data.
 *
 * @param s - The string to split
 * @param separator - The separator pattern (string or RegExp)
 * @returns Array of trimmed, non-empty parts
 */
export function splitAndTrim(s: string, separator: string | RegExp): string[] {
	return s
		.split(separator)
		.map((x) => x.trim())
		.filter(Boolean);
}
