/**********************************************************************
 * FrontmatterGenerator
 * – creates / merges front-matter from KOReader Lua metadata
 *********************************************************************/

import type {
	DocProps,
	FrontmatterData,
	FrontmatterSettings,
	LuaMetadata,
	ParsedFrontmatter,
} from "src/types";

/* ------------------------------------------------------------------ */
/*               1.  Key mapping / helpers (typed)                    */
/* ------------------------------------------------------------------ */

const ALWAYS_UPDATE: ReadonlySet<keyof FrontmatterData> = new Set([
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

/* ------------------------------------------------------------------ */
/*               2.  Value normalisers / formatters                   */
/* ------------------------------------------------------------------ */

/**
 * Checks if a value is valid for frontmatter inclusion.
 * @param value - Value to check
 * @returns True if value is not null/undefined/empty string
 */
function isValid(value: unknown): boolean {
	return value !== undefined && value !== null && String(value).trim() !== "";
}

/* ------------------------------------------------------------------ */
/*                    3.  Generator class                             */
/* ------------------------------------------------------------------ */

export class FrontmatterGenerator {
	/**
	 * Creates frontmatter data from KOReader metadata.
	 * Processes document properties, highlight counts, and reading statistics.
	 * @param meta - KOReader metadata
	 * @param opts - Frontmatter generation settings
	 * @returns Complete frontmatter data object
	 */
	createFrontmatterData(
		meta: LuaMetadata,
		opts: FrontmatterSettings,
	): FrontmatterData {
		const fm: Partial<FrontmatterData> = {};
		const disabled = new Set(opts.disabledFields ?? []);
		const extra = new Set(opts.customFields ?? []);

		/*  1️ DocProps */
		for (const [k, val] of Object.entries(meta.docProps ?? {}) as [
			keyof DocProps,
			unknown,
		][]) {
			if (!disabled.has(k) && isValid(val)) {
				fm[k as keyof FrontmatterData] = String(val);
			}
		}

		if (!fm.title) fm.title = "";
		if (!fm.authors && !disabled.has("authors")) {
			fm.authors = opts.useUnknownAuthor ? "Unknown Author" : undefined;
		}

		/*  2️  Highlight stats */
		const hl = meta.annotations?.length ?? 0;
		const notes = meta.annotations?.filter((a) => a.note?.trim()).length ?? 0;
		if (!disabled.has("highlightCount")) fm.highlightCount = hl;
		if (!disabled.has("noteCount")) fm.noteCount = notes;

		/*  3️  Reading statistics */
		const s = meta.statistics;
		if (s?.book && s.derived) {
			const statsMap = {
				pages: s.book.pages,
				lastRead: s.derived.lastReadDate.toISOString(),
				firstRead: s.derived.firstReadDate?.toISOString(),
				totalReadTime: s.book.total_read_time,
				progress: s.derived.percentComplete.toString(),
				readingStatus: s.derived.readingStatus,
				averageTimePerPage: s.derived.averageTimePerPage,
			};

			for (const [k, val] of Object.entries(statsMap) as [
				keyof typeof statsMap,
				any,
			][]) {
				if (!disabled.has(k) && isValid(val)) {
					fm[k] = val;
				}
			}
		}

		/*  4️  extra custom fields */
		for (const k of extra) {
			const docPropKey = k as keyof DocProps;
			if (!disabled.has(k) && isValid(meta.docProps?.[docPropKey])) {
				fm[k as keyof FrontmatterData] = meta.docProps?.[docPropKey] as any;
			}
		}

		return fm as FrontmatterData;
	}

	/**
	 * Merges existing frontmatter with new KOReader data.
	 * Preserves custom fields while updating statistics and counts.
	 * @param existing - Existing parsed frontmatter
	 * @param meta - New KOReader metadata
	 * @param opts - Frontmatter generation settings
	 * @returns Merged frontmatter data
	 */
	mergeFrontmatterData(
		existing: ParsedFrontmatter,
		meta: LuaMetadata,
		opts: FrontmatterSettings,
	): FrontmatterData {
		const theirs = this.createFrontmatterData(meta, opts);

		// The `existing` object is already in a key-value format.
		// We can merge directly, letting `theirs` provide updated values.
		const merged: Partial<FrontmatterData> = { ...existing, ...theirs };

		for (const key of ALWAYS_UPDATE) {
			if (key in theirs) {
				merged[key] = theirs[key];
			} else {
				delete merged[key];
			}
		}

		// guarantee presence
		merged.title ??= "";
		merged.authors ??= opts.useUnknownAuthor ? "Unknown Author" : "";

		return merged as FrontmatterData;
	}
}
