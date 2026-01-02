import { Pathing } from "../pathing";
import type { NormalizedMetadata } from "./types";

/**
 * Known strong identifier schemes that are stable across exports/devices.
 * These can safely be used as primary keys when present.
 */
const STRONG_ID_SCHEMES = new Set([
	"uuid",
	"calibre",
	"isbn",
	"mobi-asin",
	"amazon",
]);

/**
 * Known weak / source-specific identifier schemes.
 * These should not be used as primary identity across environments.
 */
const WEAK_ID_SCHEMES = new Set([
	"customid",
	// add others here if discovered (tool-specific, session-based, etc.)
]);

export interface ParsedIdentifier {
	raw: string;
	scheme: string | null;
	value: string;
	strength: "strong" | "weak" | "unknown";
}

/**
 * Parse the raw identifiers field from KOReader doc_props into structured entries.
 * Handles newline-separated values like:
 *   MOBI-ASIN:B00...
 *   AMAZON:B00...
 *   uuid:31cf...
 *   calibre:31cf...
 */
export function parseIdentifiers(
	raw: string | undefined | null,
): ParsedIdentifier[] {
	if (!raw) return [];

	return raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const idx = line.indexOf(":");
			if (idx === -1) {
				return {
					raw: line,
					scheme: null,
					value: line,
					strength: "unknown" as const,
				};
			}
			const scheme = line.slice(0, idx).trim().toLowerCase();
			const value = line.slice(idx + 1).trim();
			let strength: ParsedIdentifier["strength"] = "unknown";

			if (STRONG_ID_SCHEMES.has(scheme)) {
				strength = "strong";
			} else if (WEAK_ID_SCHEMES.has(scheme)) {
				strength = "weak";
			}

			return {
				raw: line,
				scheme,
				value,
				strength,
			};
		});
}

/**
 * Helper to determine if an authors string is clearly URL-like, which should not be
 * treated as a strong identity signal.
 */
export function isUrlLikeAuthor(authors: string[] | undefined): boolean {
	if (!authors || authors.length === 0) return false;
	const combined = authors.join(" ").trim().toLowerCase();
	return combined.startsWith("http://") || combined.startsWith("https://");
}

/**
 * Builds a normalized book key from normalized metadata.
 * This creates a stable textual identifier for deduplication and indexing.
 *
 * Unlike the old buildNormalizedBookKey, this operates on already normalized data
 * to eliminate inverse formatting bugs between display and identity generation.
 */
export function computeBookKey(meta: NormalizedMetadata): string {
	const authors = meta.authors || [];
	const title = meta.title || "";

	const titleSlug = Pathing.toMatchKey(title);

	let authorsSlug = "";
	if (!isUrlLikeAuthor(authors)) {
		// Join normalized authors with space, then normalize
		const authorsText = authors.join(" ");
		authorsSlug = Pathing.toMatchKey(authorsText);
	}

	return `${authorsSlug}::${titleSlug}`;
}

/**
 * Select the best strong identifiers (if any) from normalized metadata.
 * Callers can use these to join with KOReader stats DB or their own index.
 */
export function getStrongIdentifiers(
	meta: NormalizedMetadata,
): ParsedIdentifier[] {
	// Note: identifiers field may be in meta as a custom field, but typically comes from raw doc_props
	// For now, return empty array - this may need expansion if identifiers are stored in normalized metadata
	return [];
}

/**
 * Decide whether an md5 from KOReader stats DB can be treated as unique key.
 *
 * Callers should provide occurrenceCount from a precomputed:
 *   SELECT md5, COUNT(*) FROM book GROUP BY md5
 *
 * If occurrenceCount === 1, it's safe to use as a strong identity signal.
 */
export function isUniqueMd5(
	md5: string | null | undefined,
	occurrenceCount: number | null | undefined,
): boolean {
	if (!md5) return false;
	if (occurrenceCount == null) return false;
	return occurrenceCount === 1;
}
