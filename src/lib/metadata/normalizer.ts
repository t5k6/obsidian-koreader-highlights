import { stripHtml } from "src/lib/strings/stringUtils";
import type { FrontmatterSettings, LuaMetadata } from "src/types";
import { toFriendlyFieldKey } from "./fieldMapping";
import { cleanTitle, finalizeStringList, splitOnDelimiters } from "./textUtils";
import type { NormalizedMetadata } from "./types";

// Re-export for convenience and backward compatibility
export { toFriendlyFieldKey } from "./fieldMapping";

/**
 * Normalizes raw Lua metadata into the cleanest internal representation.
 * Handles whitespace trimming, HTML stripping, type enforcement, and array normalization.
 */
export function normalizeBookMetadata(raw: LuaMetadata): NormalizedMetadata {
	const props = raw.docProps || {};

	// Normalize authors: split on delimiters, apply consistent finalization rules
	const authorsStr = (props.authors || "").trim();
	const authors = authorsStr
		? finalizeStringList(splitOnDelimiters(authorsStr))
		: [];

	// Normalize title: singular, cleaned with consistent rules
	const titleRaw = (props.title || "").trim();
	const title = cleanTitle(stripHtml(titleRaw));

	// Normalize keywords: split on delimiters, apply consistent finalization rules
	const keywordsStr = (props.keywords || "").trim();
	const keywords = keywordsStr
		? finalizeStringList(splitOnDelimiters(keywordsStr))
		: [];

	// Normalize identifiers: KOReader newline-separated string -> clean array
	const identifiersRaw = (props.identifiers || "").trim();
	const identifiers = identifiersRaw
		? identifiersRaw
				.split(/\r?\n/)
				.map((id) => id.trim())
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
		identifiers: identifiers.length > 0 ? identifiers : undefined,
		pages: raw.pages ?? 0,
	};

	// Fallback to database language if not available in SDR doc_props
	if (!hasContent(result.language) && raw.statistics?.book.language) {
		result.language = raw.statistics.book.language;
	}

	// --- Waterfall Strategy: Use DB as source of truth, Lua as fallback ---

	// Rating from Lua (no DB equivalent)
	if (raw.luaSummary) {
		result.rating = raw.luaSummary.rating;
	}

	// Check if Lua explicitly says "complete" (this should override DB stats if present)
	const luaStatus = raw.luaSummary?.status?.toLowerCase().trim();
	const isLuaComplete = luaStatus === "complete";

	// Progress: DB takes priority, Lua is fallback (UNLESS Lua says complete)
	if (isLuaComplete) {
		result.progress = 100;
	} else if (raw.statistics?.derived) {
		const derived = raw.statistics.derived;
		result.progress = derived.percentComplete;
	} else if (raw.percentFinished !== undefined) {
		result.progress = Math.round(raw.percentFinished * 100);
	}

	// Status: DB takes priority, Lua is fallback (UNLESS Lua says complete)
	if (isLuaComplete) {
		result.readingStatus = "completed";
	} else if (raw.statistics?.derived?.readingStatus) {
		result.readingStatus = raw.statistics.derived.readingStatus;
	} else if (raw.luaSummary?.status) {
		result.readingStatus =
			luaStatus === "complete" ? "completed" : raw.luaSummary.status;
	}

	// Last Read: DB timestamp takes priority, Lua modified date is fallback
	if (raw.statistics?.derived?.lastReadDate) {
		result.lastRead = new Date(raw.statistics.derived.lastReadDate).getTime();
	} else if (raw.luaSummary?.modified) {
		result.lastRead = new Date(raw.luaSummary.modified).getTime();
	}

	// First Read: DB only (no Lua equivalent)
	if (raw.statistics?.derived?.firstReadDate) {
		result.firstRead = new Date(raw.statistics.derived.firstReadDate).getTime();
	}

	// Pages: DB takes priority, Lua stats is fallback
	if (raw.statistics?.book?.pages && raw.statistics.book.pages > 0) {
		result.pages = raw.statistics.book.pages;
	} else if (raw.luaStats?.pages) {
		result.pages = raw.luaStats.pages;
	}

	// DB-only fields
	if (raw.statistics?.derived) {
		const derived = raw.statistics.derived;
		result.averageTimePerPage = derived.averageTimePerPage || undefined;
		result.totalReadSeconds = derived.totalReadSeconds;
		result.sessionCount = derived.sessionCount;
		result.readingStreak = derived.readingStreak;
		result.avgSessionDuration = derived.avgSessionDuration;
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
		return finalizeStringList(value.map((author) => parseAuthor(author)));
	} else if (typeof value === "string") {
		// Handle delimiter-separated strings that may contain wikilinks or other markup
		// Use splitOnDelimiters for consistent parsing (handles commas, semicolons, ampersands)
		return finalizeStringList(
			splitOnDelimiters(value).map((author) => parseAuthor(author)),
		);
	} else if (typeof value === "number" || typeof value === "boolean") {
		// Coerce primitives to string
		return finalizeStringList([String(value)]);
	}
	return [];
}

function parseAuthor(author: string): string {
	if (typeof author !== "string") return "";

	// Trim first to ensure regex patterns work correctly
	const trimmed = author.trim();

	// Strip wikilink syntax: [[Display|Canonical]] → Canonical (or Display if no pipe)
	const wikilinkMatch = trimmed.match(/^\[\[(.+?)(?:\|(.+?))?\]\]$/);
	if (wikilinkMatch) {
		return wikilinkMatch[2] || wikilinkMatch[1]; // Prefer canonical, fallback to display
	}

	// Strip plain tags or other markup if added later: "#tag/content" or "@tag/content" → "content"
	return trimmed.replace(/^#[^/]*\//, "").replace(/^@[^/]*\//, "");
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
			return cleanTitle(wikilinkMatch[2] || wikilinkMatch[1]);
		}

		// Use cleanTitle for consistent title normalization
		return cleanTitle(value.replace(/[#@].*$/, ""));
	} else if (typeof value === "number" || typeof value === "boolean") {
		return cleanTitle(String(value));
	}
	return "";
}

export function parseKeywords(value: unknown): string[] {
	if (Array.isArray(value)) {
		return finalizeStringList(value.map(String).map(parseKeywordLink));
	} else if (typeof value === "string") {
		// Use splitOnDelimiters for consistent parsing across all metadata sources
		return finalizeStringList(splitOnDelimiters(value).map(parseKeywordLink));
	}
	return [];
}

/**
 * Normalizes existing YAML frontmatter back to structured data.
 * Handles cleaning wikilinks, parsing strings back to arrays, etc.
 * Extracts statistics so they can be preserved during merge.
 */
export function normalizeFrontmatter(
	fm: Record<string, unknown>,
): NormalizedMetadata {
	const get = (k: string) => fm[k] ?? fm[toFriendlyFieldKey(k)];

	const titleVal = get("title");
	const authorsVal = get("authors");

	// Helper to parse "50%" strings back to number 50
	const parsePercent = (val: unknown): number | undefined => {
		if (typeof val === "number") return val;
		if (typeof val === "string") {
			const match = val.match(/(\d+)/);
			return match ? Number.parseInt(match[1], 10) : undefined;
		}
		return undefined;
	};

	/**
	 * Parses a duration string (e.g., "10h 30m 15s") back into total seconds.
	 * Handles loose formatting like "10h", "30m", or "10h 30m".
	 * Also handles raw numeric strings like "12345".
	 */
	const parseTimeToSeconds = (val: unknown): number | undefined => {
		if (typeof val === "number") return val;
		if (typeof val !== "string") return undefined;

		// Check for simple string number "12345"
		if (/^\d+$/.test(val.trim())) {
			return Number.parseInt(val, 10);
		}

		let total = 0;
		let matched = false;

		// Extract hours
		const h = val.match(/(\d+)\s*h/);
		if (h) {
			total += Number.parseInt(h[1], 10) * 3600;
			matched = true;
		}

		// Extract minutes
		const m = val.match(/(\d+)\s*m/);
		if (m) {
			total += Number.parseInt(m[1], 10) * 60;
			matched = true;
		}

		// Extract seconds
		const s = val.match(/(\d+)\s*s/);
		if (s) {
			total += Number.parseInt(s[1], 10);
			matched = true;
		}

		return matched ? total : undefined;
	};

	// Helper to parse streak/session fields
	const parseNumber = (val: unknown): number | undefined => {
		if (typeof val === "number") return val;
		if (typeof val === "string") {
			// Handle "5 days" format
			const match = val.match(/(\d+)/);
			return match ? Number.parseInt(match[1], 10) : undefined;
		}
		return undefined;
	};

	// Helper to parse dates (ISO strings or timestamps)
	const parseDate = (val: unknown): number | undefined => {
		if (typeof val === "number") return val;
		if (typeof val === "string") {
			const timestamp = new Date(val).getTime();
			return Number.isFinite(timestamp) ? timestamp : undefined;
		}
		return undefined;
	};

	// Normalize status from frontmatter (handles legacy "complete" -> "completed")
	const rawStatus = get("readingStatus") as string | undefined;
	const normalizedStatus =
		rawStatus?.toLowerCase().trim() === "complete" ? "completed" : rawStatus;

	return {
		title: parseTitle(titleVal),
		authors: parseAuthors(authorsVal),
		description: get("description") as string | undefined,
		keywords: parseKeywords(get("keywords")),
		series: get("series") as string | undefined,
		language: get("language") as string | undefined,

		// --- Extract existing stats for preservation ---
		readingStatus: normalizedStatus,
		progress: parsePercent(get("progress")),
		totalReadSeconds: parseTimeToSeconds(get("readTime")),
		firstRead: parseDate(get("firstRead")),
		lastRead: parseDate(get("lastRead")),
		sessionCount: parseNumber(get("sessionCount")),
		readingStreak: parseNumber(get("readingStreak")),
		avgSessionDuration: parseTimeToSeconds(get("avgSessionDuration")),
		averageTimePerPage: parseTimeToSeconds(get("averageTimePerPage")),
		pages: parseNumber(get("pages")),
		highlightCount: parseNumber(get("highlightCount")),
		noteCount: parseNumber(get("noteCount")),
		rating: parseNumber(get("rating")),
	};
}

function hasContent(s?: string): boolean {
	return !!s && s.trim().length > 0;
}

// Helper to determine status weight for comparison
function getStatusRank(status?: string): number {
	const s = status?.toLowerCase().trim();
	if (s === "completed" || s === "finished" || s === "complete") return 3;
	if (s === "abandoned") return 2;
	if (s === "ongoing" || s === "reading") return 1;
	return 0; // unstarted or unknown
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

	// --- Bibliographic Preservation (Existing logic) ---
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

	// --- Statistical High-Water Mark Logic ---
	// Prevents metadata downgrades when importing without statistics.sqlite3

	// 1. Reading Status: Prevent regression from Completed -> Ongoing
	const baseRank = getStatusRank(base.readingStatus);
	const incRank = getStatusRank(merged.readingStatus);

	// If we simply don't have a new status, keep the old one
	if (!merged.readingStatus && base.readingStatus) {
		merged.readingStatus = base.readingStatus;
	}
	// If the old status was "higher" (e.g. Completed vs Ongoing), keep the old one
	else if (baseRank > incRank) {
		merged.readingStatus = base.readingStatus;
	}

	// 2. Progress: Keep the higher percentage
	const baseProg = base.progress ?? 0;
	const incProg = merged.progress ?? 0;

	// If incoming has no progress (or 0), keep base
	if (merged.progress === undefined && base.progress !== undefined) {
		merged.progress = base.progress;
	}
	// If base is higher, keep base (prevents downgrade)
	else if (baseProg > incProg) {
		merged.progress = base.progress;
	}

	// 3. Database Stats Preservation
	// If the incoming import lacks the DB stats (undefined), but we have them in the file, keep them.

	if (
		merged.totalReadSeconds === undefined &&
		base.totalReadSeconds !== undefined
	) {
		merged.totalReadSeconds = base.totalReadSeconds;
	} else if ((base.totalReadSeconds ?? 0) > (merged.totalReadSeconds ?? 0)) {
		// Even if incoming has data, if the old data is higher (accumulated time), keep it.
		merged.totalReadSeconds = base.totalReadSeconds;
	}

	if (merged.sessionCount === undefined && base.sessionCount !== undefined) {
		merged.sessionCount = base.sessionCount;
	} else if ((base.sessionCount ?? 0) > (merged.sessionCount ?? 0)) {
		merged.sessionCount = base.sessionCount;
	}

	// These fields usually don't come from Lua at all, so if they exist in base, keep them
	if (merged.readingStreak === undefined && base.readingStreak !== undefined) {
		merged.readingStreak = base.readingStreak;
	}
	if (
		merged.avgSessionDuration === undefined &&
		base.avgSessionDuration !== undefined
	) {
		merged.avgSessionDuration = base.avgSessionDuration;
	}

	// First read date should generally not change or disappear
	if (!merged.firstRead && base.firstRead) {
		merged.firstRead = base.firstRead;
	}

	// Last read: Keep the most recent
	if (!merged.lastRead && base.lastRead) {
		merged.lastRead = base.lastRead;
	} else if (
		base.lastRead &&
		merged.lastRead &&
		base.lastRead > merged.lastRead
	) {
		merged.lastRead = base.lastRead;
	}

	// Average time per page: Keep if incoming doesn't have it
	if (
		merged.averageTimePerPage === undefined &&
		base.averageTimePerPage !== undefined
	) {
		merged.averageTimePerPage = base.averageTimePerPage;
	}

	// Pages: Prefer incoming (KOReader may have updated count), but preserve if missing
	if (merged.pages === undefined && base.pages !== undefined) {
		merged.pages = base.pages;
	}

	// Highlight/note counts: These come from annotations, so incoming should have them
	// But preserve if somehow missing
	if (
		merged.highlightCount === undefined &&
		base.highlightCount !== undefined
	) {
		merged.highlightCount = base.highlightCount;
	}
	if (merged.noteCount === undefined && base.noteCount !== undefined) {
		merged.noteCount = base.noteCount;
	}

	// Rating: User-provided, preserve if incoming doesn't have it
	if (merged.rating === undefined && base.rating !== undefined) {
		merged.rating = base.rating;
	}

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
