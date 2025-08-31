import { sha1Hex, sha256Hex } from "src/lib/core/crypto";
import { err, ok, type Result } from "src/lib/core/result";
import { formatDateForTimestamp } from "src/lib/formatting";
import type { AppFailure, SnapshotError } from "./errors/types";
import { composeFrontmatter, parseFrontmatter } from "./frontmatter";
import { toFileSafe } from "./pathing";

const SNAPSHOT_HASH_CANONICALIZE_OPTS = { normalizeEol: true };

// ================================================================
// TYPES AND INTERFACES
// ================================================================

export type Uid = string;

export interface SnapshotPaths {
	dir: string;
	fileName: string; // e.g., `${uid}.md`
	fullPath: string; // `${dir}/${fileName}`
}

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
	// This line will now be type-safe
	return sha256Hex(body, SNAPSHOT_HASH_CANONICALIZE_OPTS);
}

/**
 * Parse snapshot content to extract hash and body.
 * Uses robust frontmatter parsing that handles all valid YAML variations.
 * For snapshots, remove the standard frontmatter separator (\n\n) added by composeFrontmatter,
 * preserving any additional leading whitespace from manually edited snapshots.
 */
export function parseSnapshotContent(content: string): {
	hash: string | null;
	body: string;
} {
	const parseResult = parseFrontmatter(content);

	if (!parseResult.ok) {
		// If YAML parsing fails, treat as content without frontmatter
		return { hash: null, body: content };
	}

	const body = parseResult.value.body;
	// Remove the canonical frontmatter separator if it exists at the very beginning.
	const trimmedBody = body.startsWith("\n\n") ? body.slice(2) : body;
	return {
		hash: parseResult.value.hash,
		body: trimmedBody,
	};
}

/**
 * Pure function to verify snapshot hash.
 * Only responsible for comparing expected vs computed hashes.
 */
export function verifySnapshotHash(
	body: string,
	expectedHash: string | null,
): Result<string, SnapshotError> {
	if (!expectedHash) return ok(body);
	const computed = computeSnapshotHash(body);
	if (computed !== expectedHash) {
		// Return a generic error, caller adds context
		return err(snapshotErrors.integrityFailed("Snapshot hash mismatch."));
	}
	return ok(body);
}

/**
 * Verify snapshot integrity with enhanced diagnostics.
 */
export function verifySnapshotIntegrity(
	content: string,
	context?: { path?: string },
): Result<string, AppFailure> {
	const parseResult = parseFrontmatter(content);
	if (!parseResult.ok) {
		// Return the original parse error, enriched with context.
		const error = parseResult.error;
		Object.assign(error, { path: context?.path });
		return err(error);
	}

	const body = parseResult.value.body;
	// Remove the canonical frontmatter separator if it exists at the very beginning.
	const trimmedBody = body.startsWith("\n\n") ? body.slice(2) : body;

	const verification = verifySnapshotHash(trimmedBody, parseResult.value.hash);
	if (!verification.ok) {
		// Augment the error with contextual info in the cause
		const diagnosticInfo = {
			bodyLength: trimmedBody.length,
			expected: parseResult.value.hash,
			actual: computeSnapshotHash(trimmedBody),
		};
		return err(
			snapshotErrors.integrityFailed("Snapshot hash mismatch.", {
				path: context?.path,
				diagnostics: diagnosticInfo,
			}),
		);
	}
	return ok(verification.value);
}

/**
 * Compose snapshot content with frontmatter header containing integrity hash.
 * Uses shared frontmatter composition for consistency.
 */
export function composeSnapshotContent(hash: string, body: string): string {
	return composeFrontmatter({ sha256: hash }, body);
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
	const legacyHash = sha1Hex(targetFilePath, { normalizeEol: true });
	return `${baseDir}/${legacyHash}.md`;
}
