import { Pathing } from "src/lib/pathing";
import type { DocProps } from "src/types";

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
export function isUrlLikeAuthor(authors: string | undefined | null): boolean {
	if (!authors) return false;
	const v = authors.trim().toLowerCase();
	return v.startsWith("http://") || v.startsWith("https://");
}

/**
 * Build a normalized "book key" suitable for index lookup and degraded scans.
 *
 * This improves on the old bookKeyFromDocProps by:
 * - Handling URL-like authors (down-weighted)
 * - Normalizing whitespace and punctuation consistently via Pathing.toMatchKey
 *
 * NOTE: This does NOT embed MD5 or identifiers directly. Those are used at
 * higher levels (e.g., index, statistics DB) to link logical books. Here we only
 * provide a stable textual key.
 */
export function buildNormalizedBookKey(props: DocProps): string {
	const rawAuthors = props.authors ?? "";
	const rawTitle = props.title ?? "";

	const titleSlug = Pathing.toMatchKey(rawTitle);

	let authorsSlug = "";
	if (!isUrlLikeAuthor(rawAuthors)) {
		authorsSlug = Pathing.toMatchKey(rawAuthors);
	}

	return `${authorsSlug}::${titleSlug}`;
}

/**
 * Select the best strong identifiers (if any) from doc props.
 * Callers can use these to join with KOReader stats DB or their own index.
 */
export function getStrongIdentifiers(props: DocProps): ParsedIdentifier[] {
	return parseIdentifiers((props as any).identifiers).filter(
		(id) => id.strength === "strong" && !!id.value,
	);
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
