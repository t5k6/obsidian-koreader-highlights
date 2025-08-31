import { createHash } from "node:crypto";
import { err, ok, type Result } from "src/lib/core/result";
import { normalizeWhitespace } from "src/lib/strings/stringUtils";

export type CanonicalizeOptions = {
	normalizeEol?: boolean; // default true: CRLF -> LF
	trim?: boolean; // default false
	collapseWhitespace?: boolean; // default false
};

/**
 * Applies a set of normalization rules to a string to produce a canonical representation.
 * This ensures that hashing operations are consistent across different environments and inputs.
 *
 * @param input The string to canonicalize.
 * @param opts Options to control normalization.
 * @returns The canonicalized string.
 */
export function canonicalize(
	input: string,
	opts: CanonicalizeOptions = {
		normalizeEol: true,
		trim: false,
		collapseWhitespace: false,
	},
): string {
	const {
		normalizeEol = true,
		trim = false,
		collapseWhitespace = false,
	} = opts;

	let s = String(input ?? "");

	if (normalizeEol) {
		s = s.replace(/\r\n/g, "\n");
	}

	// Use the robust normalizeWhitespace utility if both trim and collapse are requested.
	if (trim && collapseWhitespace) {
		s = normalizeWhitespace(s);
	} else {
		// Otherwise, apply them independently to respect specific cases (e.g., collapse only).
		if (collapseWhitespace) {
			s = s.replace(/\s+/g, " ");
		}
		if (trim) {
			s = s.trim();
		}
	}

	return s;
}

/**
 * Internal hashing utility for Node.js crypto.
 * @param algorithm The hash algorithm (e.g., 'sha1', 'sha256').
 * @param canonicalizedInput The pre-canonicalized string to hash.
 * @returns The hex-encoded hash digest.
 */
function _nodeHash(algorithm: string, canonicalizedInput: string): string {
	return createHash(algorithm).update(canonicalizedInput, "utf8").digest("hex");
}

/**
 * Synchronously computes a SHA-1 hash of the input string.
 * Uses Node.js's built-in crypto module.
 */
export function sha1Hex(input: string, opts?: CanonicalizeOptions): string {
	const s = canonicalize(input, opts);
	return _nodeHash("sha1", s);
}

/**
 * Synchronously computes a SHA-256 hash of the input string.
 * Uses Node.js's built-in crypto module.
 */
export function sha256Hex(input: string, opts?: CanonicalizeOptions): string {
	const s = canonicalize(input, opts);
	return _nodeHash("sha256", s);
}

/**
 * Asynchronously computes a SHA-256 hash of the input string, returning a Result.
 * Prefers the Web Crypto API (`crypto.subtle`) if available, falling back to Node.js crypto.
 * This is the preferred method for hashing in potentially browser-like environments.
 *
 * @returns A `Result` containing the hex string on success, or an `Error` on failure.
 */
export async function sha256HexAsync(
	input: string,
	opts?: CanonicalizeOptions,
): Promise<Result<string, Error>> {
	const s = canonicalize(input, opts);
	const subtle = (globalThis as any).crypto?.subtle;

	// Prefer Web Crypto API (available in modern Node, Deno, and browsers)
	if (subtle) {
		try {
			const enc = new TextEncoder().encode(s);
			const buf = await subtle.digest("SHA-256", enc);
			const hex = [...new Uint8Array(buf)]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			return ok(hex);
		} catch (e) {
			return err(e instanceof Error ? e : new Error("Web Crypto API failed"));
		}
	}

	// Fallback to Node.js crypto module
	try {
		return ok(_nodeHash("sha256", s));
	} catch (e) {
		return err(
			new Error(
				"Crypto fallback failed: Node.js crypto module is unavailable or threw an error.",
			),
		);
	}
}

/**
 * Asynchronously computes a SHA-1 hash of an ArrayBuffer, returning a Result.
 * Prefers the Web Crypto API (`crypto.subtle`) if available, falling back to a non-cryptographic hash.
 * This is the preferred method for hashing in potentially browser-like environments.
 *
 * @returns A `Result` containing the hex string on success, or an `Error` on failure.
 */
export async function sha1HexOfBuffer(
	buf: ArrayBuffer,
): Promise<Result<string, Error>> {
	try {
		const cryptoObj: Crypto | undefined = (globalThis as any)?.crypto;
		if (cryptoObj?.subtle?.digest) {
			const out = await cryptoObj.subtle.digest("SHA-1", buf);
			const bytes = new Uint8Array(out);
			const hex = Array.from(bytes)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			return ok(hex);
		}
	} catch (e) {
		return err(new Error("Hashing failed"));
	}
	// Fallback: non-cryptographic quick hash (best effort in environments w/o subtle.crypto)
	const bytes = new Uint8Array(buf);
	let h = 0;
	for (let i = 0; i < bytes.length; i++) {
		h = ((h << 5) - h + bytes[i]!) | 0;
	}
	return ok(h.toString(16));
}

/**
 * A consolidated object of cryptographic utilities for easy injection or namespacing.
 */
export const CryptoUtils = {
	canonicalize,
	sha1Hex,
	sha256Hex,
	sha256HexAsync,
	sha1HexOfBuffer,
};
