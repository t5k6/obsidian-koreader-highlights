import { stripHtml } from "src/lib/strings/stringUtils";
import type { FrontmatterSettings, LuaMetadata } from "src/types";
import type { NormalizedMetadata } from "./types";

/**
 * Normalizes raw Lua metadata into the cleanest internal representation.
 * Handles whitespace trimming, HTML stripping, type enforcement, and array normalization.
 */
export function normalizeBookMetadata(raw: LuaMetadata): NormalizedMetadata {
	const props = raw.docProps || {};

	// Normalize authors: split on commas, trim, filter empty, always as array
	const authorsStr = (props.authors || "").trim();
	const authors = authorsStr
		? authorsStr
				.split(/\s*[,;&]\s*/)
				.map((a) => a.trim())
				.filter(Boolean)
		: [];

	// Normalize title: singular, cleaned
	let title = (props.title || "").trim();
	if (title && stripHtml(title) !== title) {
		title = stripHtml(title);
	}

	// Normalize keywords: split on commas/newlines, trim, always as array
	const keywordsStr = (props.keywords || "").trim();
	const keywords = keywordsStr
		? keywordsStr
				.split(/[,;\n]/)
				.map((k) => k.trim())
				.filter(Boolean)
		: [];

	// Normalize other string fields
	let description = (props.description || "").trim();
	if (description && stripHtml(description) !== description) {
		description = stripHtml(description);
	}

	const result: NormalizedMetadata = {
		title: title || "",
		authors,
		description: description || undefined,
		keywords: keywords.length > 0 ? keywords : undefined,
		series: (props.series || "").trim() || undefined,
		language: props.language ? props.language.trim() || undefined : undefined,
		pages: raw.statistics?.book.pages ?? raw.pages ?? 0,
	};

	// Fallback to database language if not available in SDR doc_props
	if (!hasContent(result.language) && raw.statistics?.book.language) {
		result.language = raw.statistics.book.language;
	}

	// Handle statistics if present
	if (raw.statistics?.book && raw.statistics?.derived) {
		const book = raw.statistics.book;
		const derived = raw.statistics.derived;
		result.readingStatus = derived.readingStatus;
		result.progress =
			derived.percentComplete >= 0 && derived.percentComplete <= 100
				? derived.percentComplete / 100 // Convert percent to decimal
				: undefined;
		result.lastRead = derived.lastReadDate
			? new Date(derived.lastReadDate).getTime()
			: undefined;
		result.firstRead = derived.firstReadDate
			? new Date(derived.firstReadDate).getTime()
			: undefined;
		result.totalReadTime = book.total_read_time || undefined;
		result.averageTimePerPage = derived.averageTimePerPage || undefined;
	}

	// Add highlight/note counts
	if (raw.annotations) {
		result.highlightCount = raw.annotations.length;
		result.noteCount = raw.annotations.filter((a) => a.note?.trim()).length;
	}

	return result;
}

/**
 * Inverse parser functions for extracting clean values from formatted frontmatter.
 * These are used when reading existing notes back into the system.
 */

export function parseAuthors(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((author) => parseAuthor(author)).filter(Boolean);
	} else if (typeof value === "string") {
		// Handle comma-separated strings that may contain wikilinks or other markup
		return value
			.split(",")
			.map((author) => parseAuthor(author.trim()))
			.filter(Boolean);
	} else if (typeof value === "number" || typeof value === "boolean") {
		// Coerce primitives to string
		return [String(value)].filter(Boolean);
	}
	return [];
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

function parseKeywordLink(keyword: string): string {
	if (typeof keyword !== "string") return "";

	// Strip wikilink syntax: [[Display|Canonical]] → Canonical (or Display if no pipe)
	const wikilinkMatch = keyword.match(/^\[\[(.+?)(?:\|(.+?))?\]\]$/);
	if (wikilinkMatch) {
		return wikilinkMatch[2] || wikilinkMatch[1]; // Prefer canonical, fallback to display
	}

	return keyword.trim();
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

export function parseKeywords(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(String).map(parseKeywordLink).filter(Boolean);
	} else if (typeof value === "string") {
		return value
			.split(",")
			.map((k) => k.trim())
			.map(parseKeywordLink)
			.filter(Boolean);
	}
	return [];
}

/**
 * Normalizes existing YAML frontmatter back to structured data.
 * Handles cleaning wikilinks, parsing strings back to arrays, etc.
 */
export function normalizeFrontmatter(
	fm: Record<string, unknown>,
): NormalizedMetadata {
	const get = (k: string) => fm[k] ?? fm[toFriendlyFieldKey(k)];

	const titleVal = get("title");
	const authorsVal = get("authors");

	return {
		title: parseTitle(titleVal),
		authors: parseAuthors(authorsVal),
		// We largely trust existing frontmatter for other fields or don't need them
		// for the merge decision logic (which mostly overwrites stats).
		description: get("description") as string | undefined,
		keywords: parseKeywords(get("keywords")),
		series: get("series") as string | undefined,
		language: get("language") as string | undefined,
	};
}

function hasContent(s?: string): boolean {
	return !!s && s.trim().length > 0;
}

function toFriendlyFieldKey(key: string): string {
	const CANONICAL_TO_FRIENDLY: Record<string, string> = {
		title: "Title",
		authors: "Author(s)",
		description: "Description",
		keywords: "Keywords",
		series: "Series",
		language: "Language",
		pages: "Page Count",
		highlightCount: "Highlight Count",
		noteCount: "Note Count",
		lastRead: "Last Read Date",
		firstRead: "First Read Date",
		totalReadTime: "Total Read Duration",
		progress: "Reading Progress",
		readingStatus: "Status",
		averageTimePerPage: "Avg. Time Per Page",
	};

	return CANONICAL_TO_FRIENDLY[key] ?? key;
}

/**
 * Merges normalized metadata using field-level policies.
 */
export function mergeNormalizedMetadata(
	base: NormalizedMetadata,
	incoming: NormalizedMetadata,
	settings: FrontmatterSettings,
): NormalizedMetadata {
	const merged = { ...incoming };

	// Policy: Preserve bibliographic data if missing in incoming (or if incoming is default)
	if (!hasContent(merged.title) && hasContent(base.title)) {
		merged.title = base.title;
	}

	if (
		(!merged.authors.length || merged.authors[0] === "Unknown Author") &&
		base.authors.length > 0
	) {
		merged.authors = base.authors;
	}

	if (!hasContent(merged.description) && hasContent(base.description)) {
		merged.description = base.description;
	}

	if (
		(!merged.keywords || merged.keywords.length === 0) &&
		base.keywords?.length
	) {
		merged.keywords = base.keywords;
	}

	if (!hasContent(merged.series) && hasContent(base.series)) {
		merged.series = base.series;
	}

	if (!hasContent(merged.language) && hasContent(base.language)) {
		merged.language = base.language;
	}

	// Stats are generally overwritten by incoming (KOReader is source of truth for stats)
	return merged;
}

/**
 * Parse book metadata fields from frontmatter, applying inverse formatting.
 */
export function parseBookMetadataFields(frontmatter: Record<string, unknown>): {
	title: string;
	authors: string[];
} {
	return {
		title: parseTitle(frontmatter.title),
		authors: parseAuthors(frontmatter.authors),
	};
}
