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
	totalReadTime: (rawValue) => {
		if (typeof rawValue === "number") return formatDurationHms(rawValue);
		if (typeof rawValue === "string" && /^\d+$/.test(rawValue.trim())) {
			const n = Number(rawValue.trim());
			return Number.isFinite(n) ? formatDurationHms(n) : rawValue;
		}
		return String(rawValue);
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
 */
function shouldIncludeField(
	key: keyof FrontmatterData,
	value: unknown,
): boolean {
	if (value == null) return false;
	if (typeof value === "string" && value.trim() === "") return false;

	// Restore the empty array check that was present in the original hasValue()
	if (Array.isArray(value) && value.length === 0) return false;

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

	// --- Handle Keywords to Tags Logic ---
	const { keywordsAsTags } = opts;
	let keywordsToProcess: string[] = [];

	// Extract keywords if available (from data.keywords)
	if (data.keywords && Array.isArray(data.keywords)) {
		keywordsToProcess = data.keywords;
	} else if (typeof data.keywords === "string") {
		// Fallback if somehow it's a string, split by comma
		keywordsToProcess = splitAndTrim(data.keywords, ",");
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
		// Inject tags into data so it gets processed
		(data as any).tags = tags;
	}

	if (keywordsAsTags === "replace") {
		// Remove keywords from data so it doesn't get processed
		delete data.keywords;
	}
	// -------------------------------------

	// Helper to format and add a single field
	const processField = (key: string, rawValue: unknown) => {
		const canonicalKey = key as keyof FrontmatterData;

		if (disabledFields.has(key)) return;
		if (processedKeys.has(key)) return; // Prevent duplicates

		let displayValue: unknown = rawValue;
		const formatter = FIELD_FORMATTERS[canonicalKey];
		if (formatter) {
			displayValue = formatter(rawValue, opts);
		}

		if (shouldIncludeField(canonicalKey, displayValue)) {
			const friendlyKey = toFriendlyFieldKey(key);
			(result as any)[friendlyKey] = displayValue;
		}
		processedKeys.add(key);
	};

	// 1. Process keys in the defined display order (Bibliographic -> Stats)
	for (const key of DISPLAY_KEY_ORDER) {
		// Only process if the data object actually has this key
		if (Object.hasOwn(data, key as string)) {
			processField(key as string, data[key as string]);
		}
	}

	// 2. Process any remaining keys (Custom fields, internal flags)
	for (const key of Object.keys(data)) {
		processField(key, data[key]);
	}

	return result as FrontmatterData;
}
