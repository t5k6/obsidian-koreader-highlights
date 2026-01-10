import type { FrontmatterData, FrontmatterSettings } from "src/types";
import { formatDateResult } from "../formatting";
import {
	formatDurationHms,
	formatShortDuration,
} from "../formatting/dateUtils";
import { Pathing } from "../pathing";
import { splitAndTrim, stripHtml } from "../strings/stringUtils";
import { DISPLAY_KEY_ORDER, toFriendlyFieldKey } from "./fieldMapping";
import type { NormalizedMetadata } from "./types";

/**
 * Field formatters for converting normalized metadata to display-ready frontmatter values.
 * These apply final user-facing formatting like wikilinks, date strings, and units.
 */
type FieldFormatter = (value: unknown, opts: FrontmatterSettings) => unknown;

/**
 * Formatters map normalized field values to their display representations.
 * Identical to the original FIELD_FORMATTERS from noteCore.ts.
 */
const FIELD_FORMATTERS: Record<
	keyof FrontmatterData,
	FieldFormatter | undefined
> = {
	lastRead: (rawValue) => {
		const r = formatDateResult(
			rawValue as string | number | Date,
			"{YYYY}-{MM}-{DD}",
		);
		return r.ok ? r.value : "";
	},
	firstRead: (rawValue) => {
		const r = formatDateResult(
			rawValue as string | number | Date,
			"{YYYY}-{MM}-{DD}",
		);
		return r.ok ? r.value : "";
	},
	readTime: (rawValue, opts) => {
		const seconds = typeof rawValue === "number" ? rawValue : null;
		if (seconds === null) return rawValue;

		return opts.durationFormat === "seconds"
			? seconds
			: formatDurationHms(seconds);
	},
	averageTimePerPage: (rawValue) => {
		if (typeof rawValue === "number") return formatShortDuration(rawValue);
		if (typeof rawValue === "string" && /^\d+(\.\d+)?$/.test(rawValue.trim())) {
			const n = Number(rawValue.trim());
			return Number.isFinite(n) ? formatShortDuration(n) : rawValue;
		}
		return String(rawValue);
	},
	progress: (rawValue) => {
		const n = Number(rawValue);
		return Number.isFinite(n) ? `${Math.round(n)}%` : String(rawValue ?? "");
	},
	authors: (rawValue) => {
		if (Array.isArray(rawValue)) {
			const links = rawValue.map((a) => {
				const escaped = a.replace(/([[\]|#^])/g, "\\$1");
				return `[[${escaped}]]`;
			});
			return links.length === 1 ? links[0] : links;
		}
		if (typeof rawValue === "string" && rawValue.startsWith("[["))
			return rawValue;
		const arr = splitAndTrim(String(rawValue), /\s*[,;&\n]\s*/);
		const links = arr.map((a) => {
			const escaped = a.replace(/([[\]|#^])/g, "\\$1");
			return `[[${escaped}]]`;
		});
		return links.length === 1 ? links[0] : links;
	},
	keywords: (rawValue) => {
		// Explicitly handle null/undefined to prevent "undefined" string coercion
		if (rawValue === null || rawValue === undefined) return [];

		const arr = Array.isArray(rawValue)
			? rawValue
			: splitAndTrim(String(rawValue), /,/);

		return arr.map((k: unknown) => {
			const trimmed = String(k).trim();
			// If already a link, return as is
			if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) return trimmed;

			// Sanitize for safe filenames (keywords may have illegal chars like ':')
			// We keep spaces and case, but remove filesystem illegal chars.
			const safe = Pathing.toFileSafe(trimmed, {
				maxLength: 0,
				lower: false,
				ascii: false,
			});
			// Escape Wikilink special chars like | ] # ^
			const escaped = safe.replace(/([[\]|#^])/g, "\\$1");
			return `[[${escaped}]]`;
		});
	},
	description: (rawValue) => stripHtml(String(rawValue ?? "")),
	rating: (rawValue) => {
		// Clamp rating between 1-5
		if (typeof rawValue === "number") {
			return Math.max(1, Math.min(5, rawValue));
		}
		return rawValue;
	},
	sessionCount: undefined, // Simple integer, pass through
	readingStreak: (rawValue) => {
		const n = Number(rawValue);
		if (!Number.isFinite(n) || n <= 0) return undefined;
		return n === 1 ? "1 day" : `${n} days`;
	},
	avgSessionDuration: (rawValue) => {
		if (typeof rawValue === "number" && rawValue > 0) {
			return formatShortDuration(rawValue);
		}
		return undefined;
	},
	// Other fields: undefined for pass-through
	title: undefined,
	series: undefined,
	language: undefined,
	pages: undefined,
	highlightCount: undefined,
	noteCount: undefined,
	readingStatus: undefined,
} as const;

/**
 * Checks if a field value should be included in the display frontmatter.
 * Hides empty/null values and zero counts by default.
 *
 * Applies contextual filtering based on reading status to keep frontmatter clean:
 * - Progress is only shown for actively reading books (ongoing status)
 */
function shouldIncludeField(
	key: keyof FrontmatterData,
	value: unknown,
	data: NormalizedMetadata,
): boolean {
	if (value == null) return false;
	if (typeof value === "string" && value.trim() === "") return false;

	// Restore the empty array check that was present in the original hasValue()
	if (Array.isArray(value) && value.length === 0) return false;

	// CONTEXTUAL FILTERING: Hide progress for completed books
	// Progress is process state, not archive state - only show while actively reading
	// Note: unstarted books are never imported (filtered at import stage), so we don't handle them here
	if (key === "progress" && data.readingStatus === "completed") {
		return false;
	}

	// CONTEXTUAL FILTERING: Hide raw session count (replaced by streak/avgSession for ongoing)
	// sessionCount is internal metadata, not user-facing insight
	if (key === "sessionCount") {
		return false;
	}

	// CONTEXTUAL FILTERING: Show reading momentum metrics only for ongoing books
	// Streak and average session duration are "process metrics" for active reading
	if (
		(key === "readingStreak" || key === "avgSessionDuration") &&
		data.readingStatus !== "ongoing"
	) {
		return false;
	}

	// Don't include zero values for counts/statistics, except pages which is meaningful to show
	if ((key === "highlightCount" || key === "noteCount") && value === 0)
		return false;
	return true;
}

/**
 * Converts normalized metadata to display-ready frontmatter data.
 * Applies all formatting transformations and respects the canonical key order.
 */
export function formatForDisplay(
	data: NormalizedMetadata,
	opts: FrontmatterSettings,
): FrontmatterData {
	const disabledFields = new Set(
		opts.disabledFields.map((f) => f.toLowerCase()),
	);

	const result: Partial<FrontmatterData> = {};
	const processedKeys = new Set<string>();

	// Map totalReadSeconds to readTime for formatting
	const dataWithReadTime = { ...data };
	if (data.totalReadSeconds !== undefined) {
		(dataWithReadTime as any).readTime = data.totalReadSeconds;
		delete (dataWithReadTime as any).totalReadSeconds;
	}

	// --- Handle Keywords to Tags Logic ---
	const { keywordsAsTags } = opts;
	let keywordsToProcess: string[] = [];

	// Extract keywords if available (from dataWithReadTime.keywords)
	if (dataWithReadTime.keywords && Array.isArray(dataWithReadTime.keywords)) {
		keywordsToProcess = dataWithReadTime.keywords;
	} else if (typeof dataWithReadTime.keywords === "string") {
		keywordsToProcess = splitAndTrim(dataWithReadTime.keywords, ",");
	}

	if (keywordsAsTags !== "none" && keywordsToProcess.length > 0) {
		const tags = keywordsToProcess.map(
			(k) =>
				k
					.replace(/[[\]]/g, "") // Remove wikilink brackets
					.replace(/&/g, "and") // Semantic replacement for &
					.trim()
					.replace(/\s+/g, "-") // Spaces to dashes
					.replace(/[^a-zA-Z0-9\-_/]/g, ""), // Remove any remaining invalid chars (Obsidian tags: alphanum, -, _, /)
		);
		(dataWithReadTime as any).tags = tags;
	}

	if (keywordsAsTags === "replace") {
		delete (dataWithReadTime as any).keywords;
	}
	// -------------------------------------

	const processField = (key: string, rawValue: unknown) => {
		const canonicalKey = key as keyof FrontmatterData;

		if (disabledFields.has(key)) return;
		if (processedKeys.has(key)) return;

		// Skip internal metadata fields that should not appear in frontmatter
		if (key === "identifiers" || key === "sessionCount") return;

		let displayValue: unknown = rawValue;
		const formatter = FIELD_FORMATTERS[canonicalKey];
		if (formatter) {
			displayValue = formatter(rawValue, opts);
		}

		if (shouldIncludeField(canonicalKey, displayValue, dataWithReadTime)) {
			const friendlyKey = toFriendlyFieldKey(key);
			(result as any)[friendlyKey] = displayValue;
		}
		processedKeys.add(key);
	};

	for (const key of DISPLAY_KEY_ORDER) {
		if (Object.hasOwn(dataWithReadTime, key as string)) {
			processField(key as string, (dataWithReadTime as any)[key as string]);
		}
	}

	for (const key of Object.keys(dataWithReadTime)) {
		processField(key, (dataWithReadTime as any)[key]);
	}

	return result as FrontmatterData;
}
