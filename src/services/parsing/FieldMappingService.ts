export class FieldMappingService {
	// Canonical field names used internally across the app
	// Maps canonical -> friendly (as shown in Obsidian frontmatter)
	private static readonly CANONICAL_TO_FRIENDLY = {
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
	} as const;

	// Reverse map built once for normalization: friendly (lower) -> canonical
	private static readonly FRIENDLY_TO_CANONICAL = Object.entries(
		FieldMappingService.CANONICAL_TO_FRIENDLY,
	).reduce<Record<string, string>>((acc, [canonical, friendly]) => {
		acc[friendly.toLowerCase()] = canonical;
		return acc;
	}, {});

	// Lua metadata/annotation field names to canonical names used in TS models
	// This consolidates all the per-file mini-maps.
	private static readonly LUA_TO_CANONICAL = {
		// Annotation fields
		chapter: "chapter",
		chapter_name: "chapter",
		datetime: "datetime",
		date: "datetime",
		text: "text",
		notes: "note",
		note: "note",
		color: "color",
		draw_type: "drawer",
		drawer: "drawer",
		pageno: "page",
		page: "page",
		pos0: "pos0",
		pos1: "pos1",

		// Common doc_props keys (pass-through, documented for clarity)
		title: "title",
		authors: "authors",
		description: "description",
		keywords: "keywords",
		series: "series",
		language: "language",
	} as const;

	/** Returns the friendly label for a canonical field. Falls back to original key. */
	static toFriendly(canonical: string): string {
		return (
			(FieldMappingService.CANONICAL_TO_FRIENDLY as Record<string, string>)[
				canonical
			] ?? canonical
		);
	}

	/** Maps a Lua field name to our canonical field name. Falls back to original key. */
	static fromLua(luaField: string): string {
		return (
			(FieldMappingService.LUA_TO_CANONICAL as Record<string, string>)[
				luaField
			] ?? luaField
		);
	}

	/**
	 * Normalizes an input field name that may be canonical or friendly into canonical.
	 * Case-insensitive for friendly names.
	 */
	static normalize(field: string): string {
		if (!field) return field;
		const lower = field.toLowerCase();
		// If the input matches a known friendly label (case-insensitive), map to canonical
		const byFriendly = FieldMappingService.FRIENDLY_TO_CANONICAL[lower];
		if (byFriendly) return byFriendly;
		// Otherwise assume it's already canonical
		return field;
	}
}
