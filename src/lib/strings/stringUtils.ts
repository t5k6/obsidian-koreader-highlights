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
};

const UNESCAPE_MAP: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
};

/**
 * Escapes HTML special characters in a string.
 * Converts characters that have special meaning in HTML to their entity equivalents.
 *
 * @param s - The string to escape
 * @returns The HTML-escaped string
 */
export function escapeHtml(s: string): string {
	return s.replace(/[&<>]/g, (c) => htmlEntities[c]!);
}

/**
 * Unescapes common HTML entities back to their literal characters.
 * Reverses the most common HTML entity encoding for improved readability.
 *
 * @param s - The string to unescape
 * @returns The HTML-unescaped string
 */
export function unescapeHtml(s: string): string {
	return s.replace(
		/&(?:amp|lt|gt|quot|#39);/g,
		(match) => UNESCAPE_MAP[match] ?? match,
	);
}

/**
 * Escapes Markdown special characters to prevent unwanted formatting.
 * Only escapes : \ ` * _ [ ]
 * Does not escape < > to allow HTML tags in templates.
 *
 * @param s - The string to escape
 * @returns The Markdown-escaped string
 */
export function escapeMarkdown(s: string): string {
	// 1. Escape backslashes first to prevent double-escaping subsequent chars
	// 2. Escape formatting chars that cause issues in normal text: ` * _ [ ]
	// HTML tags are allowed, as highlight text is HTML-escaped.
	return s.replace(/\\/g, "\\\\").replace(/([`*_[\]])/g, "\\$1");
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
	const decoded = unescapeHtml(s);
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

/**
 * A robust replacement for JSON.stringify that handles circular references,
 * BigInts, and other edge cases without throwing.
 * @param obj The object to stringify.
 * @param space Indentation for pretty-printing.
 * @returns A JSON string representation of the object.
 */
export function safeStringify(
	obj: unknown,
	space: number | string = 2,
): string {
	const seen = new WeakSet();
	const replacer = (key: string, value: unknown) => {
		if (typeof value === "object" && value !== null) {
			if (seen.has(value)) {
				return "[Circular Reference]";
			}
			seen.add(value);
		}

		if (typeof value === "bigint") {
			return `${value.toString()}n`;
		}

		return value;
	};

	try {
		return JSON.stringify(obj, replacer, space);
	} catch (e) {
		return `[Unserializable Object: ${e instanceof Error ? e.message : String(e)}]`;
	}
}
