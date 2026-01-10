import { Pathing } from "../pathing";
import type { NormalizedMetadata } from "./types";

export type BookKeyInput = {
	// allow both normalized and raw doc_props-like inputs
	title?: string | null | undefined;
	authors?: string[] | string | null | undefined;
};

function normalizeAuthors(authors: BookKeyInput["authors"]): string[] {
	if (!authors) return [];
	if (Array.isArray(authors)) return authors.filter(Boolean);
	// DocProps-style string; treat commas/newlines as separators (best-effort)
	return String(authors)
		.split(/\r?\n|,/)
		.map((a) => a.trim())
		.filter(Boolean);
}

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
export function isUrlLikeAuthor(authors: BookKeyInput["authors"]): boolean {
	const normalized = normalizeAuthors(authors);
	if (normalized.length === 0) return false;
	const combined = normalized.join(" ").trim().toLowerCase();
	return combined.startsWith("http://") || combined.startsWith("https://");
}

/**
 * Builds a normalized book key from either normalized metadata or raw doc props.
 * This creates a stable textual identifier for deduplication and indexing.
 *
 * Handles both array and comma/newline-separated author formats, and normalizes
 * both title and authors to create a consistent key for matching and deduplication.
 */
export function buildBookKey(input: BookKeyInput): string {
	const authors = normalizeAuthors(input.authors);
	const title = input.title ?? "";

	const titleSlug = Pathing.toMatchKey(title);

	let authorsSlug = "";
	if (!isUrlLikeAuthor(authors)) {
		const authorsText = authors.join(" ");
		authorsSlug = Pathing.toMatchKey(authorsText);
	}

	return `${authorsSlug}::${titleSlug}`;
}

/**
 * Select the best strong identifiers (if any) from normalized metadata.
 * Callers can use these to join with KOReader stats DB or their own index.
 */
/**
 * Select the best strong identifiers (if any) from a doc_props-like object.
 *
 * Note: `DocProps` does not currently declare an `identifiers` field in its type,
 * but KOReader provides it in practice. We therefore accept any object with an
 * optional `identifiers` string and read it dynamically.
 */
export function getStrongIdentifiers(input: unknown): ParsedIdentifier[] {
	const identifiers = (input as any)?.identifiers as
		| string
		| string[]
		| null
		| undefined;

	const raw = Array.isArray(identifiers)
		? identifiers.join("\n")
		: (identifiers as string | null | undefined);

	return parseIdentifiers(raw).filter(
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
