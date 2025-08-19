/**
 * The canonical regex for detecting and extracting YAML frontmatter.
 * Do not redefine this elsewhere; import it from this module.
 */
export const FRONTMATTER_REGEX = /^---\s*?\r?\n([\s\S]+?)\r?\n---\s*?\r?\n?/;

/**
 * Splits a string into its YAML frontmatter block and the remaining body.
 * This is the canonical implementation.
 * @param content The full string content.
 * @returns An object with the YAML content (or null) and the body.
 */
export function splitFrontmatter(content: string): {
	yaml: string | null;
	body: string;
} {
	const match = content.match(FRONTMATTER_REGEX);
	if (!match) {
		return { yaml: null, body: content };
	}
	// match[1] is the captured YAML content.
	// match[0] is the entire frontmatter block including delimiters.
	return { yaml: match[1] ?? null, body: content.slice(match[0].length) };
}

/**
 * Strips the YAML frontmatter block from a string, returning only the body.
 * @param content The full string content.
 * @returns The body of the content.
 */
export function stripFrontmatter(content: string): string {
	return content.replace(FRONTMATTER_REGEX, "");
}

/**
 * Extracts only the YAML frontmatter string from content, without the '---' delimiters.
 * @param content The full string content.
 * @returns The YAML string, or null if no frontmatter is found.
 */
export function extractFrontmatter(content: string): string | null {
	const match = content.match(FRONTMATTER_REGEX);
	return match ? match[1] : null;
}

/**
 * Checks if a string contains a YAML frontmatter block.
 * @param content The string to check.
 * @returns True if frontmatter exists, false otherwise.
 */
export function hasFrontmatter(content: string): boolean {
	return FRONTMATTER_REGEX.test(content);
}
