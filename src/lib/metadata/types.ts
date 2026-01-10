/**
 * Normalized metadata: the cleanest, most consistent internal representation.
 * - Whitespace trimmed
 * - HTML stripped
 * - Types enforced (numbers as numbers, not strings)
 * - No display formatting (no wikilinks, standardized dates)
 */
export interface NormalizedMetadata {
	// Bibliographic
	title: string;
	authors: string[]; // Always as array of clean author names
	description?: string;
	keywords?: string[]; // Always as array
	series?: string;
	language?: string;
	identifiers?: string[];

	// Page counts / stats
	pages?: number;

	// Reading progress (DB is source of truth, Lua is fallback)
	readingStatus?: string; // "reading", "completed", "abandoned"
	progress?: number; // Percentage 0-100
	lastRead?: number; // Timestamp in milliseconds (best available)
	firstRead?: number; // Timestamp in milliseconds
	averageTimePerPage?: number; // Seconds per page

	// Highlight counts
	highlightCount?: number;
	noteCount?: number;

	// Bibliographic metadata
	rating?: number; // 1-5 stars

	// DB Source (Enrichment only)
	totalReadSeconds?: number; // Canonical duration field
	sessionCount?: number;
	readingStreak?: number; // Consecutive days with reading activity
	avgSessionDuration?: number; // Average session duration in seconds

	// Custom fields (any other key-value pairs)
	[key: string]: string | string[] | number | undefined;
}
