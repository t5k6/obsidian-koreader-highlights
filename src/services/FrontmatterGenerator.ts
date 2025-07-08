import { stringifyYaml } from "obsidian";
import {
	formatDate,
	formatPercent,
	secondsToHoursMinutesSeconds,
} from "src/utils/formatUtils";
import { logger } from "src/utils/logging";
import type {
	DocProps,
	FrontmatterData,
	FrontmatterSettings,
	LuaMetadata,
	ParsedFrontmatter,
} from "../types";

const FRIENDLY_KEY_MAP: Record<string, string> = {
	title: "Title",
	authors: "Author(s)",
	description: "Description",
	keywords: "Keywords",
	series: "Series",
	language: "Language",
	pages: "Page Count",
	highlightCount: "Highlight Count",
	noteCount: "Note Count",
	lastRead: "Last Read Date",
	firstRead: "First Read Date",
	totalReadTime: "Total Read Duration",
	progress: "Reading Progress",
	readingStatus: "Status",
	averageTimePerPage: "Avg. Time Per Page",
};

function toTitleCase(str: string): string {
	if (!str) return "";
	const spaced = str.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
	return spaced
		.split(" ")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
}

function getFriendlyKey(key: string): string {
	return FRIENDLY_KEY_MAP[key] || toTitleCase(key);
}

export class FrontmatterGenerator {
	constructor() {}

	public createFrontmatterData(
		metadata: LuaMetadata,
		settings: FrontmatterSettings,
	): FrontmatterData {
		const { docProps, statistics, annotations } = metadata;
		const frontmatter: Partial<FrontmatterData> = {};

		const disabled = new Set(settings?.disabledFields || []);
		const customFields = settings?.customFields || [];

		// --- 1. Add ALL DocProps fields if not disabled ---
		if (docProps) {
			for (const key in docProps) {
				const typedKey = key as keyof DocProps;
				if (!disabled.has(typedKey) && this.isValidValue(docProps[typedKey])) {
					(frontmatter as any)[typedKey] = docProps[typedKey];
				}
			}
		}

		// Default title/authors if they weren't in docProps
		if (!frontmatter.title) {
			frontmatter.title = ""; // Always have a title, even if empty
		}

		if (!frontmatter.authors && !disabled.has("authors")) {
			frontmatter.authors = settings.useUnknownAuthor
				? "Unknown Author"
				: undefined;
		}

		// --- 2. Calculate and add Highlight/Note Counts ---
		const highlightCount = annotations?.length ?? 0;
		const noteCount =
			annotations?.filter((a) => a.note && a.note.trim().length > 0).length ??
			0;

		if (!disabled.has("highlightCount")) {
			frontmatter.highlightCount = highlightCount;
		}
		if (!disabled.has("noteCount")) frontmatter.noteCount = noteCount;

		// --- 3. Add RAW statistics fields if not disabled ---
		if (statistics?.derived && statistics.book) {
			const statsMap = {
				pages: statistics.book.pages,
				lastRead: statistics.derived.lastReadDate,
				totalReadTime: statistics.book.total_read_time,
				progress: statistics.derived.percentComplete,
				readingStatus: statistics.derived.readingStatus,
				averageTimePerPage: statistics.derived.averageTimePerPage,
				firstRead: statistics.derived.firstReadDate,
			};

			for (const key in statsMap) {
				const typedKey = key as keyof typeof statsMap;
				if (
					!disabled.has(typedKey) &&
					this.isValidStatValue(statsMap[typedKey])
				) {
					// Assign the RAW value, do not format it here.
					(frontmatter as any)[typedKey] = statsMap[typedKey];
				}
			}
		}

		// --- 4. Add custom fields ---
		if (docProps) {
			for (const field of customFields) {
				if (
					!disabled.has(field) &&
					(frontmatter as any)[field] === undefined &&
					this.isValidValue(docProps[field as keyof DocProps])
				) {
					(frontmatter as any)[field] = docProps[field as keyof DocProps];
				}
			}
		}

		return frontmatter as FrontmatterData;
	}

	public mergeFrontmatterData(
		existingFm: ParsedFrontmatter,
		newMetadata: LuaMetadata,
		settings: FrontmatterSettings,
	): FrontmatterData {
		// 1. Generate the ideal frontmatter object from the new data.
		const theirData = this.createFrontmatterData(newMetadata, settings);

		// 2. Convert existing frontmatter (friendly keys) to programmatic keys
		const reverseKeyMap = new Map(
			Object.entries(FRIENDLY_KEY_MAP).map(([pKey, fKey]) => [fKey, pKey]),
		);

		const ourData: Record<string, any> = {};
		for (const friendlyKey in existingFm) {
			const progKey = reverseKeyMap.get(friendlyKey) ?? friendlyKey;
			ourData[progKey] = existingFm[friendlyKey];
		}

		// 3. Define keys to always update from the new import.
		const alwaysUpdateKeys = new Set([
			"lastRead",
			"firstRead",
			"totalReadTime",
			"progress",
			"readingStatus",
			"averageTimePerPage",
			"highlightCount",
			"noteCount",
			"pages",
		]);

		// 4. Perform the merge. Start with ourData to preserve user edits by default.
		const mergedData: Record<string, any> = { ...ourData };

		for (const key in theirData) {
			if (alwaysUpdateKeys.has(key) || !Object.hasOwn(mergedData, key)) {
				(mergedData as any)[key] = (theirData as any)[key];
			}
		}

		// 5. Preserve all custom fields from existing frontmatter that weren't handled above
		for (const friendlyKey in existingFm) {
			// If the friendly key isn't a value in FRIENDLY_KEY_MAP, it's a custom field
			const isCustomField =
				!Object.values(FRIENDLY_KEY_MAP).includes(friendlyKey);
			if (
				isCustomField && // Not a standard field
				!alwaysUpdateKeys.has(friendlyKey) && // Not an always-update field
				!mergedData[friendlyKey] // Not already set
			) {
				mergedData[friendlyKey] = existingFm[friendlyKey];
			}
		}

		// Ensure required fields like title/authors exist, even if empty.
		if (mergedData.title === undefined)
			mergedData.title = theirData.title || "";
		if (mergedData.authors === undefined)
			mergedData.authors = theirData.authors || "";

		return mergedData as FrontmatterData;
	}

	private isValidValue(value: unknown): boolean {
		if (value === null || value === undefined) return false;
		if (typeof value === "string") return value.trim().length > 0;
		return true; // Allow numbers, booleans etc.
	}

	private isValidStatValue(value: unknown): boolean {
		return value !== undefined && value !== null;
	}

	private formatDocPropValue(key: string, value: string): string | string[] {
		// Ensure value is a string before processing, or handle other types if necessary
		const strValue = String(value);

		switch (key) {
			case "authors": {
				const authorsList = strValue
					.split(/\s*[,;\n]\s*|\s*\n\s*/) // Split by comma, semicolon, or newline
					.map((a) => a.trim())
					.filter(Boolean);

				if (authorsList.length === 0) {
					return ""; // No valid authors found
				}
				// Format as Obsidian links
				const linkedAuthors = authorsList.map((author) => `[[${author}]]`);

				// Return single string for one author, array for multiple for proper YAML list
				return linkedAuthors.length === 1 ? linkedAuthors[0] : linkedAuthors;
			}
			case "description":
				// Basic HTML tag removal
				return this.decodeHtmlEntities(strValue.replace(/<[^>]+>/g, ""));
			case "keywords":
				return strValue
					.split(",")
					.map((k) => k.trim())
					.filter(Boolean);
			default:
				return strValue.trim();
		}
	}

	private formatStatValue(key: string, value: unknown): string | number {
		switch (key) {
			case "lastRead":
			case "firstRead":
				return value instanceof Date
					? formatDate(value.toISOString())
					: typeof value === "string" && value
						? formatDate(value)
						: "";
			case "totalReadTime":
				return secondsToHoursMinutesSeconds(value as number);
			case "averageTimePerPage":
				return secondsToHoursMinutesSeconds((value as number) * 60);

			// value is in minutes
			case "progress": {
				const numericValue = parseInt(String(value), 10);
				if (Number.isNaN(numericValue)) {
					logger.warn(
						`FrontmatterGenerator: Could not parse numeric value for progress: ${value}`,
					);
					return "0%"; // Return a sensible default on failure
				}
				return formatPercent(numericValue);
			}

			case "pages":
			case "highlightCount":
			case "noteCount":
				return typeof value === "number" ? value : 0;
			case "readingStatus":
				return String(value ?? "");
			default:
				return String(value ?? "");
		}
	}

	private decodeHtmlEntities(str: string): string {
		const entities: Record<string, string> = {
			"&": "&",
			"<": "<",
			">": ">",
		};
		return str.replace(/&[#\w]+;/g, (match) => entities[match] || match);
	}

	public generateYamlFromLuaMetadata(
		metadata: LuaMetadata,
		settings: FrontmatterSettings,
	): string {
		const data = this.createFrontmatterData(metadata, settings);
		return this.formatDataToYaml(data, {
			useFriendlyKeys: true,
			sortKeys: true,
		});
	}

	public formatDataToYaml(
		data: FrontmatterData | ParsedFrontmatter,
		options: {
			useFriendlyKeys?: boolean;
			sortKeys?: boolean;
		} = {},
	): string {
		const { useFriendlyKeys = true, sortKeys = true } = options;
		const finalObject: Record<string, any> = {};

		const entries = Object.entries(data);

		if (sortKeys) {
			entries.sort(([aKey], [bKey]) => aKey.localeCompare(bKey));
		}

		for (const [key, rawValue] of entries) {
			if (rawValue === undefined || rawValue === null) continue;
			if (
				useFriendlyKeys &&
				(key === "highlightCount" || key === "noteCount") &&
				rawValue === 0
			)
				continue;

			const formattedKey = useFriendlyKeys ? getFriendlyKey(key) : key;

			let finalValue = rawValue;
			if (
				[
					"lastRead",
					"firstRead",
					"totalReadTime",
					"averageTimePerPage",
					"progress",
					"readingStatus",
				].includes(key)
			) {
				finalValue = this.formatStatValue(key, rawValue);
			} else if (["authors", "description", "keywords"].includes(key)) {
				if (key === "authors") {
					const isSingleLink =
						typeof rawValue === "string" && rawValue.startsWith("[[");
					const isArrayOfLinks =
						Array.isArray(rawValue) &&
						rawValue.every((item) => String(item).startsWith("[["));

					if (isSingleLink || isArrayOfLinks) {
						finalValue = rawValue; // Already formatted, pass through.
					} else {
						// Not formatted, so apply formatting.
						finalValue = this.formatDocPropValue(key, String(rawValue));
					}
				} else {
					// For other fields like description/keywords, format as usual.
					finalValue = this.formatDocPropValue(key, String(rawValue));
				}
			}

			if (finalValue === "" && !Array.isArray(finalValue)) continue;

			finalObject[formattedKey] = finalValue;
		}

		if (Object.keys(finalObject).length === 0) {
			return "";
		}

		const yamlString = stringifyYaml(finalObject);

		return `---\n${yamlString}---`;
	}
}
