import { KOHL_UID_KEY } from "src/constants";

/**
 * RFC4122 v4 UUID validation (case-insensitive).
 */
export function validateUid(s: unknown): s is string {
	if (typeof s !== "string") return false;
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		s.trim(),
	);
}

/**
 * Get random bytes using crypto.getRandomValues.
 * @param len Number of bytes to generate
 * @returns Uint8Array of random bytes
 */
function getRandomBytes(len: number): Uint8Array {
	const a = new Uint8Array(len);
	crypto.getRandomValues(a);
	return a;
}

/**
 * Generate a UUID v4 using cryptographic randomness.
 */
export function generateUid(): string {
	const bytes = getRandomBytes(16);
	// Per RFC 4122 §4.4
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
		16,
		20,
	)}-${hex.slice(20)}`;
}

/**
 * Read UID from a frontmatter-like object (case: exact KOHL_UID_KEY).
 */
export function extractUidFromFrontmatter(
	fm: Record<string, unknown> | undefined | null,
): string | undefined {
	if (!fm || typeof fm !== "object") return undefined;
	const v = (fm as any)[KOHL_UID_KEY];
	return typeof v === "string" && validateUid(v) ? v : undefined;
}

/**
 * Purely returns a new object with UID updated to newUid.
 * - If oldUid provided but different, we overwrite with newUid (source of truth).
 * - Leaves all other keys intact.
 */
export function updateUidFrontmatter<T extends Record<string, unknown>>(
	fm: T,
	newUid: string,
): T {
	const out = { ...(fm as Record<string, unknown>) };
	(out as any)[KOHL_UID_KEY] = newUid;
	return out as T;
}
