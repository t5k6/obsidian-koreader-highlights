/**
 * Shared text normalization utilities for metadata processing.
 *
 * These primitives ensure consistent "clean string" definitions across
 * different input sources (KOReader Lua, Obsidian YAML, etc.)
 */

/**
 * Finalizes a list of strings by applying consistent normalization rules:
 * - Trims whitespace
 * - Filters empty strings
 * - Removes common placeholder values ("unknown", "n/a", etc.)
 * - Deduplicates while preserving order
 *
 * This ensures that regardless of input format (Lua, YAML, etc.),
 * the final output follows the same cleanliness rules.
 */
export function finalizeStringList(items: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const item of items) {
		const cleaned = item.trim();

		// Skip empty strings
		if (cleaned.length === 0) continue;

		// Skip common placeholder values (case-insensitive)
		const lower = cleaned.toLowerCase();
		if (lower === "unknown" || lower === "n/a" || lower === "none") continue;

		// Deduplicate (case-sensitive to preserve user's formatting choice)
		if (seen.has(cleaned)) continue;

		seen.add(cleaned);
		result.push(cleaned);
	}

	return result;
}

/**
 * Splits a string on multiple delimiters commonly used in metadata fields.
 * Supports: commas, semicolons, ampersands, and newlines.
 *
 * This ensures consistent parsing whether the source is KOReader Lua
 * (which uses commas/semicolons) or user-edited YAML (which might use any delimiter).
 */
export function splitOnDelimiters(text: string): string[] {
	if (!text) return [];

	// Split on: comma, semicolon, ampersand, newline
	// The regex /[,;&\n\r]+/ handles multiple delimiters in a row
	return text.split(/[,;&\n\r]+/).filter(Boolean);
}

/**
 * Cleans a single title string by removing common formatting artifacts.
 * - Strips HTML tags and entities
 * - Removes leading/trailing brackets/quotes
 * - Normalizes whitespace
 *
 * Used by both KOReader and frontmatter normalizers to ensure
 * consistent title formatting.
 */
export function cleanTitle(title: string | null | undefined): string {
	if (!title) return "";

	let cleaned = title.trim();

	// Remove HTML entities (common in KOReader metadata)
	cleaned = cleaned.replace(/&[a-z]+;/gi, " ");

	// Remove leading/trailing brackets, quotes, or parentheses (but only from edges)
	cleaned = cleaned.replace(/^[[("']+/, "");
	cleaned = cleaned.replace(/[\])"']+$/, "");

	// Normalize multiple spaces to single space
	cleaned = cleaned.replace(/\s+/g, " ");

	return cleaned.trim();
}
