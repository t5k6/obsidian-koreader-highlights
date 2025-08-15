import { parse } from "path";

/**
 * Simplifies KOReader SDR directory names to human-readable format.
 * Removes series prefixes, duplicate tokens, and duplicate blocks.
 * Case-insensitive but preserves first spelling encountered.
 *
 * Examples:
 * - "(Series-1) Title - Author - Title" → "Title - Author"
 * - "A - B - C - A - B - C" → "A - B - C"
 *
 * @param raw - The raw SDR directory name
 * @param delimiter - Separator to use (default " - ")
 * @returns Simplified filename or "Untitled" if result is empty
 */
export function simplifySdrName(raw: string, delimiter = " - "): string {
	if (!raw) {
		return "";
	}

	// ── 0. Strip a prepended "(……)" leader
	raw = raw.replace(/^\([^)]*\)\s*/, "").trim();

	const parts = raw
		.split(delimiter)
		.map((p) => p.trim())
		.filter(Boolean);

	// ── 1. Drop REPEATED TOKENS  (case-insensitive)
	const seen = new Set<string>();
	const uniq: string[] = [];
	for (const p of parts) {
		const key = p.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			uniq.push(p);
		}
	}

	// ── 2. Drop REPEATED BLOCKS  (A B C  A B C  →  A B C)
	const tokens = [...uniq];
	let changed = true;

	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

	while (changed) {
		changed = false;

		for (let block = Math.floor(tokens.length / 2); block >= 1; block--) {
			// slide a window over the list; whenever we see  [X…] [X…]  collapse it
			outer: for (let i = 0; i + 2 * block <= tokens.length; i++) {
				for (let j = 0; j < block; j++) {
					if (!same(tokens[i + j], tokens[i + block + j])) {
						continue outer; // not identical → keep looking
					}
				}
				// Found a duplicate block – delete the second copy
				tokens.splice(i + block, block);
				changed = true;
				break;
			}
			if (changed) break; // restart with the (possibly) shorter array
		}
	}

	const finalName = tokens.join(delimiter);
	// If the resulting name contains no letters or numbers, it's likely not a real title.
	if (finalName && !/[a-zA-Z0-9]/.test(finalName)) {
		return "Untitled";
	}
	return finalName || "Untitled";
}

/**
 * Normalizes a string to be safe for use in filenames.
 * Removes invalid filesystem characters and cleans whitespace.
 * @param piece - String to normalize (can be null/undefined)
 * @returns Normalized string safe for filenames
 */
export function normalizeFileNamePiece(
	piece: string | undefined | null,
): string {
	if (!piece) return "";
	// Remove invalid file system characters, trim, replace multiple spaces/underscores
	return piece
		.replace(/[\\/:*?"<>|#%&{}[\]]+/g, "_")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Extracts filename without extension from a file path.
 * @param filePath - Full file path or filename
 * @returns Filename without extension, empty string if undefined
 */
export function getFileNameWithoutExt(filePath: string | undefined): string {
	if (!filePath) return "";
	return parse(filePath).name;
}
