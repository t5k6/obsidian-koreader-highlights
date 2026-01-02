/**
 * Field key mappings for consistent field naming between internal canonical keys
 * and user-facing friendly display keys.
 */
export const CANONICAL_TO_FRIENDLY: Record<string, string> = {
	title: "Title",
	authors: "Author(s)",
	description: "Description",
	keywords: "Keywords",
	tags: "Tags",
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

export const FRIENDLY_TO_CANONICAL: Record<string, string> = Object.entries(
	CANONICAL_TO_FRIENDLY,
).reduce(
	(acc, [canon, friend]) => ({ ...acc, [friend.toLowerCase()]: canon }),
	{} as Record<string, string>,
);

export function normalizeFieldKey(key: string): string {
	return FRIENDLY_TO_CANONICAL[key.toLowerCase()] ?? key;
}

export function toFriendlyFieldKey(key: string): string {
	return CANONICAL_TO_FRIENDLY[key] ?? key;
}

/**
 * Key ordering for consistent YAML output.
 */
export const DISPLAY_KEY_ORDER: (keyof import("src/types").FrontmatterData)[] =
	[
		"title",
		"authors",
		"description",
		"keywords",
		"tags",
		"series",
		"language",
		"pages",
		"readingStatus",
		"progress",
		"firstRead",
		"lastRead",
		"totalReadTime",
		"averageTimePerPage",
		"highlightCount",
		"noteCount",
	];
