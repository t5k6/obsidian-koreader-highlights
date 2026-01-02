import type { FrontmatterData } from "src/types";
import type { NormalizedMetadata } from "./types";

export * from "./fieldMapping";
export * from "./formatter";
export * from "./identity";
export * from "./normalizer";
export * from "./types";

/**
 * Converts normalized metadata to FrontmatterData format without display formatting.
 * This provides canonical frontmatter values (joined authors, raw dates, etc.) ready for further processing.
 */
export function normalizedToFrontmatter(
	normalized: NormalizedMetadata,
): FrontmatterData {
	const result: any = { ...normalized };

	// Convert authors array to string (single author as string, multiple joined)
	if (Array.isArray(result.authors)) {
		result.authors =
			result.authors.length === 1 ? result.authors[0] : result.authors;
	}

	// Convert progress to string percentage
	if (typeof result.progress === "number") {
		result.progress = `${Math.round(result.progress * 100)}%`;
	}

	// Convert timestamps to formatted dates
	if (result.lastRead) {
		const date = new Date(result.lastRead);
		result.lastRead = date.toISOString().split("T")[0]; // YYYY-MM-DD
	}
	if (result.firstRead) {
		const date = new Date(result.firstRead);
		result.firstRead = date.toISOString().split("T")[0]; // YYYY-MM-DD
	}

	// Keep other fields as-is but ensure correct types
	return result as FrontmatterData;
}
