import { bookKeyFromDocProps } from "src/lib/formatting/formatUtils";
import { toMatchKey } from "src/lib/pathing";
import type { DocProps } from "src/types";

/**
 * Pure function to check if frontmatter matches a book key
 */
export function frontmatterMatchesBook(
	frontmatter: { title?: unknown; authors?: unknown } | undefined,
	bookKey: string,
): boolean {
	if (!frontmatter) return false;

	const title = typeof frontmatter.title === "string" ? frontmatter.title : "";
	let authors = "";
	if (typeof frontmatter.authors === "string") {
		authors = frontmatter.authors;
	} else if (Array.isArray(frontmatter.authors)) {
		authors = frontmatter.authors.join(", ");
	}

	// Use the canonical bookKeyFromDocProps utility to ensure logic is identical
	const fmBookKey = bookKeyFromDocProps({ title, authors });
	return fmBookKey === bookKey;
}

/**
 * Build expected filename keys for matching
 */
export function buildExpectedFilenameKeys(docProps: DocProps): Set<string> {
	const keys = new Set<string>();
	const titleKey = toMatchKey(docProps.title);
	const authorsKey = toMatchKey(docProps.authors);

	if (titleKey && authorsKey) {
		// For filenames that preserve word boundaries
		keys.add(`${titleKey} ${authorsKey}`);
		keys.add(`${authorsKey} ${titleKey}`);
	}
	if (titleKey) keys.add(titleKey);
	if (authorsKey) keys.add(authorsKey);

	return keys;
}

/**
 * Check if a filename stem matches expected keys
 */
export function filenameMatchesKeys(
	basename: string,
	expectedKeys: Set<string>,
): boolean {
	const stem = basename.replace(/(?:\s*(?:\[[^\]]*]|\([^)]*\)))+$/g, "");
	return expectedKeys.has(toMatchKey(stem));
}
