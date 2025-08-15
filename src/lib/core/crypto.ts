import { createHash } from "crypto";

export type CanonicalizeOptions = {
	normalizeEol?: boolean; // default true: CRLF -> LF
	trim?: boolean; // default false
	collapseWhitespace?: boolean; // default false
};

export function canonicalize(
	input: string,
	opts: CanonicalizeOptions = {},
): string {
	const {
		normalizeEol = true,
		trim = false,
		collapseWhitespace = false,
	} = opts;
	let s = String(input ?? "");
	if (normalizeEol) s = s.replace(/\r\n/g, "\n");
	if (trim) s = s.trim();
	if (collapseWhitespace) s = s.replace(/\s+/g, " ");
	return s;
}

// Sync (Node/Electron)
export function sha1Hex(input: string, opts?: CanonicalizeOptions): string {
	const s = canonicalize(input, opts);
	return createHash("sha1").update(s, "utf8").digest("hex");
}

export function sha256Hex(input: string, opts?: CanonicalizeOptions): string {
	const s = canonicalize(input, opts);
	return createHash("sha256").update(s, "utf8").digest("hex");
}

export async function sha256HexAsync(
	input: string,
	opts?: CanonicalizeOptions,
): Promise<string> {
	const subtle = (globalThis as any).crypto?.subtle;
	if (!subtle) {
		try {
			return sha256Hex(input, opts);
		} catch {
			throw new Error(
				"SubtleCrypto not available and Node crypto not accessible.",
			);
		}
	}
	const s = canonicalize(input, opts);
	const enc = new TextEncoder().encode(s);
	const buf = await subtle.digest({ name: "SHA-256" }, enc);
	return [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export const CryptoUtils = {
	canonicalize,
	sha1Hex,
	sha256Hex,
	sha256HexAsync,
};
