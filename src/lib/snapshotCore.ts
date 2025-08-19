import { createHash } from "node:crypto";
import { sha1Hex } from "src/lib/core/crypto";
import { err, ok, type Result } from "src/lib/core/result";
import { formatDateForTimestamp } from "src/lib/formatting";
import { toFileSafe } from "./pathing";

// ================================================================
// TYPES AND INTERFACES
// ================================================================

export type Uid = string;
export type SnapshotKind = "snapshot" | "backup";

export interface SnapshotMeta {
	uid: Uid;
	kind: SnapshotKind;
	createdTs: number; // epoch ms
	hash: string; // computed from content (implementation-specific)
}

export interface SnapshotPaths {
	dir: string;
	fileName: string; // e.g., `${uid}.md`
	fullPath: string; // `${dir}/${fileName}`
}

export type SnapshotError =
	| { kind: "NOT_FOUND"; message: string }
	| { kind: "READ_FAILED"; message: string; cause?: unknown }
	| { kind: "WRITE_FAILED"; message: string; cause?: unknown }
	| { kind: "INTEGRITY_FAILED"; message: string; cause?: unknown }
	| { kind: "CAPABILITY_UNAVAILABLE"; message: string }
	| { kind: "TARGET_FILE_MISSING"; message: string }
	| { kind: "SNAPSHOT_MISSING"; message: string }
	| { kind: "WRITE_FORBIDDEN"; message: string; cause?: unknown }
	| { kind: "READ_FORBIDDEN"; message: string; cause?: unknown }
	| { kind: "UID_MISSING"; message: string }
	| { kind: "UID_MISMATCH"; message: string }
	| { kind: "MIGRATION_FAILED"; message: string; cause?: unknown };

// ================================================================
// ERROR FACTORY FUNCTIONS
// ================================================================

export const snapshotErrors = {
	notFound: (message: string): SnapshotError => ({
		kind: "NOT_FOUND",
		message,
	}),
	readFailed: (message: string, cause?: unknown): SnapshotError => ({
		kind: "READ_FAILED",
		message,
		cause,
	}),
	writeFailed: (message: string, cause?: unknown): SnapshotError => ({
		kind: "WRITE_FAILED",
		message,
		cause,
	}),
	integrityFailed: (message: string, cause?: unknown): SnapshotError => ({
		kind: "INTEGRITY_FAILED",
		message,
		cause,
	}),
	capabilityUnavailable: (message: string): SnapshotError => ({
		kind: "CAPABILITY_UNAVAILABLE",
		message,
	}),
	targetFileMissing: (message: string): SnapshotError => ({
		kind: "TARGET_FILE_MISSING",
		message,
	}),
	snapshotMissing: (message: string): SnapshotError => ({
		kind: "SNAPSHOT_MISSING",
		message,
	}),
	writeForbidden: (message: string, cause?: unknown): SnapshotError => ({
		kind: "WRITE_FORBIDDEN",
		message,
		cause,
	}),
	readForbidden: (message: string, cause?: unknown): SnapshotError => ({
		kind: "READ_FORBIDDEN",
		message,
		cause,
	}),
	uidMissing: (message: string): SnapshotError => ({
		kind: "UID_MISSING",
		message,
	}),
	uidMismatch: (message: string): SnapshotError => ({
		kind: "UID_MISMATCH",
		message,
	}),
	migrationFailed: (message: string, cause?: unknown): SnapshotError => ({
		kind: "MIGRATION_FAILED",
		message,
		cause,
	}),
};

// ================================================================
// UTILITY FUNCTIONS (PURE, SELF-CONTAINED)
// ================================================================

/**
 * Pure string canonicalization for consistent hashing.
 * Mirrors existing behavior: canonicalizes line endings prior to hashing.
 */
function canonicalize(input: string, normalizeEol = true): string {
	let s = String(input ?? "");
	if (normalizeEol) s = s.replace(/\r\n/g, "\n");
	return s;
}

/**
 * Generate SHA-256 hash of input string.
 * Used for content integrity verification.
 */
function sha256Hex(input: string, normalizeEol = true): string {
	const s = canonicalize(input, normalizeEol);
	return createHash("sha256").update(s, "utf8").digest("hex");
}

// ================================================================
// PATH GENERATION LOGIC (PURE FUNCTIONS)
// ================================================================

/**
 * Generate the standard filename for a snapshot given a UID.
 * Maintains compatibility with existing naming convention.
 */
export function snapshotFileNameForUid(uid: Uid): string {
	return `${uid}.md`;
}

/**
 * Generate snapshot directory and file paths for a given UID.
 * This is a pure function that takes the base directory as an argument.
 */
export function snapshotPathForUid(baseDir: string, uid: Uid): SnapshotPaths {
	const fileName = snapshotFileNameForUid(uid);
	return {
		dir: baseDir,
		fileName,
		fullPath: `${baseDir}/${fileName}`, // vault paths use forward slashes
	};
}

/**
 * Generates a backup filename based on the original file's properties.
 * Pure function that takes all necessary inputs as parameters.
 */
export function generateBackupFileName(
	baseName: string,
	filePath: string,
): string {
	const safeBase = toFileSafe(baseName, {
		lower: false,
		fallback: "note",
	}).slice(0, 50);
	const pathHash = sha1Hex(filePath).slice(0, 8);
	const ts = formatDateForTimestamp();
	return `${safeBase}-${pathHash}-${ts}.md`;
}

// ================================================================
// COMPUTATION LOGIC (PURE FUNCTIONS)
// ================================================================

/**
 * Compute the canonical integrity hash for a snapshot body.
 * This uses SHA-256 and should not be changed without a migration plan for existing snapshots.
 * Mirrors existing behavior: canonicalizes line endings prior to hashing.
 */
export function computeSnapshotHash(body: string): string {
	return sha256Hex(body, true);
}

/**
 * Parse snapshot content to extract hash and body.
 * Returns null hash if no header is present.
 */
export function parseSnapshotContent(content: string): {
	hash: string | null;
	body: string;
} {
	if (!content.startsWith("---\n")) {
		return { hash: null, body: content };
	}

	const sep = "---\n\n";
	const sepIdx = content.indexOf(sep);
	if (sepIdx === -1) {
		return { hash: null, body: content };
	}

	const headerSection = content.substring(0, sepIdx);
	const body = content.substring(sepIdx + sep.length);

	// Extract sha256 from header lines
	const lines = headerSection.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("sha256:")) {
			const hash = trimmed.substring(7).trim();
			return { hash: hash || null, body };
		}
	}

	return { hash: null, body };
}

/**
 * Verify snapshot integrity by checking the embedded hash against computed hash.
 * Returns Result with body on success or SnapshotError on integrity failure.
 *
 * NOTE: For backward compatibility with existing tests, we return READ_FAILED
 * when integrity checks fail, rather than INTEGRITY_FAILED.
 */
export function verifySnapshotIntegrity(
	content: string,
): Result<string, SnapshotError> {
	const { hash, body } = parseSnapshotContent(content);

	// No hash means no integrity check needed
	if (!hash) {
		return ok(body);
	}

	const computed = computeSnapshotHash(body);
	if (computed !== hash) {
		return err(
			snapshotErrors.readFailed("Snapshot integrity check failed", {
				expected: hash,
				actual: computed,
			}),
		);
	}

	return ok(body);
}

/**
 * Compose snapshot content with frontmatter header containing integrity hash.
 */
export function composeSnapshotContent(hash: string, body: string): string {
	return `---
sha256: ${hash}
---

${body}`;
}

/**
 * Generates the vault-relative path for a legacy, path-hash-based snapshot.
 * @param baseDir The base directory for snapshots (e.g., '.obsidian/plugins/.../snapshots').
 * @param targetFilePath The vault-relative path of the original note.
 * @returns The full vault-relative path to the legacy snapshot file.
 */
export function legacySnapshotPathFor(
	baseDir: string,
	targetFilePath: string,
): string {
	const legacyHash = sha1Hex(targetFilePath);
	// Vault paths always use forward slashes
	return `${baseDir}/${legacyHash}.md`;
}
