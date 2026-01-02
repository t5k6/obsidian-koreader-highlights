import type { FrontmatterData } from "src/types";

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

	// Page counts / stats
	pages?: number;

	// Reading progress
	readingStatus?: string;
	progress?: number; // Decimal 0-1
	lastRead?: number; // Timestamp in milliseconds
	firstRead?: number; // Timestamp in milliseconds
	totalReadTime?: number; // Seconds
	averageTimePerPage?: number; // Seconds per page

	// Highlight counts
	highlightCount?: number;
	noteCount?: number;

	// Custom fields (any other key-value pairs)
	[key: string]: string | string[] | number | undefined;
}
