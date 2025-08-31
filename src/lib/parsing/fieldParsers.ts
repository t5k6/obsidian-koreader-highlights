/**
 * Inverse formatters: Normalize formatted frontmatter values back to canonical form.
 * Used for computation (e.g., book keys) where display markup interferes.
 */
export function parseAuthors(value: unknown): string {
	if (Array.isArray(value)) {
		return value
			.map((author) => parseAuthor(author))
			.filter(Boolean)
			.join(", ");
	} else if (typeof value === "string") {
		// Handle comma-separated strings that may contain wikilinks or other markup
		return value
			.split(",")
			.map((author) => parseAuthor(author.trim()))
			.filter(Boolean)
			.join(", ");
	} else if (typeof value === "number" || typeof value === "boolean") {
		// Coerce primitives to string
		return String(value);
	}
	return "";
}

function parseAuthor(author: string): string {
	if (typeof author !== "string") return "";

	// Strip wikilink syntax: [[Display|Canonical]] → Canonical (or Display if no pipe)
	const wikilinkMatch = author.match(/^\[\[(.+?)(?:\|(.+?))?\]\]$/);
	if (wikilinkMatch) {
		return wikilinkMatch[2] || wikilinkMatch[1]; // Prefer canonical, fallback to display
	}

	// Strip plain tags or other markup if added later: "#tag/content" or "@tag/content" → "content"
	return author
		.replace(/^#[^/]*\//, "")
		.replace(/^@[^/]*\//, "")
		.trim();
}

export function parseTitle(value: unknown): string {
	if (Array.isArray(value)) {
		return "";
	} else if (typeof value === "string") {
		// Strip any potential wikilink or tag markup (future-proof)
		const wikilinkMatch = value.match(/^\[\[(.+?)(?:\|(.+?))?\]\]$/);
		if (wikilinkMatch) {
			return wikilinkMatch[2] || wikilinkMatch[1];
		}

		return value.replace(/[#@].*$/, "").trim();
	} else if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return "";
}

/**
 * Parse book metadata fields, applying inverse formatting.
 */
export function parseBookMetadataFields(frontmatter: Record<string, unknown>): {
	title: string;
	authors: string;
} {
	return {
		title: parseTitle(frontmatter.title),
		authors: parseAuthors(frontmatter.authors),
	};
}
