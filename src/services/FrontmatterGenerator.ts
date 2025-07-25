/**********************************************************************
 * FrontmatterGenerator
 * – creates / merges front-matter from KOReader Lua metadata
 *********************************************************************/

import { stringifyYaml } from "obsidian";
import {
	formatDate,
	formatDateWithFormat,
	formatPercent,
	secondsToHoursMinutesSeconds,
} from "src/utils/formatUtils";
import type {
	DocProps,
	FrontmatterData,
	FrontmatterSettings,
	LuaMetadata,
	ParsedFrontmatter,
} from "../types";

/* ------------------------------------------------------------------ */
/*               1.  Key mapping / helpers (typed)                    */
/* ------------------------------------------------------------------ */

const FRIENDLY_KEY_MAP = {
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
} satisfies Record<keyof FrontmatterData, string>;

type ProgKey = keyof typeof FRIENDLY_KEY_MAP;
const ALWAYS_UPDATE: ReadonlySet<ProgKey> = new Set([
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

const reverseMap = new Map(
	Object.entries(FRIENDLY_KEY_MAP).map(([k, v]) => [v.toLowerCase(), k]),
);

/* ------------------------------------------------------------------ */
/*               2.  Value normalisers / formatters                   */
/* ------------------------------------------------------------------ */

function isValid(value: unknown): boolean {
	return value !== undefined && value !== null && String(value).trim() !== "";
}

function splitAndTrim(s: string, rx: RegExp): string[] {
	return s
		.split(rx)
		.map((x) => x.trim())
		.filter(Boolean);
}

function formatDocProp(key: keyof DocProps, v: unknown): string | string[] {
	const str = String(v);
	switch (key) {
		case "authors": {
			// Return plain string or array, do not format as links
			const arr = splitAndTrim(str, /\s*[,;\n]\s*/);
			return arr.length === 1 ? arr[0] : arr;
		}
		case "keywords":
			return splitAndTrim(str, /,/);
		case "description":
			return str.replace(/<[^>]+>/g, ""); // strip html
		default:
			return str.trim();
	}
}

function formatStat(key: ProgKey, v: unknown): string | number {
	switch (key) {
		case "lastRead":
		case "firstRead":
			return v instanceof Date
				? formatDate(v.toISOString())
				: typeof v === "string"
					? formatDate(v)
					: "";
		case "totalReadTime":
			return secondsToHoursMinutesSeconds(Number(v));
		case "averageTimePerPage":
			return secondsToHoursMinutesSeconds(Number(v) * 60);
		case "progress":
			return formatPercent(Number(v));
		default:
			return typeof v === "number" ? v : String(v);
	}
}

/* ------------------------------------------------------------------ */
/*                    3.  Generator class                             */
/* ------------------------------------------------------------------ */

export class FrontmatterGenerator {
	/* --------- creation from scratch ---------- */
	createFrontmatterData(
		meta: LuaMetadata,
		opts: FrontmatterSettings,
	): FrontmatterData {
		const fm: Record<string, unknown> = {}; // Use a flexible record to build the object
		const disabled = new Set(opts.disabledFields ?? []);
		const extra = new Set(opts.customFields ?? []);

		/*  1️⃣  DocProps */
		for (const [k, val] of Object.entries(meta.docProps ?? {}) as [
			keyof DocProps,
			unknown,
		][]) {
			if (!disabled.has(k) && isValid(val)) {
				fm[k] = formatDocProp(k, val);
			}
		}

		if (!fm.title) fm.title = "";
		if (!fm.authors && !disabled.has("authors")) {
			fm.authors = opts.useUnknownAuthor ? "Unknown Author" : undefined;
		}

		/*  2️⃣  Highlight stats */
		const hl = meta.annotations?.length ?? 0;
		const notes = meta.annotations?.filter((a) => a.note?.trim()).length ?? 0;
		if (!disabled.has("highlightCount")) fm.highlightCount = hl;
		if (!disabled.has("noteCount")) fm.noteCount = notes;

		/*  3️⃣  Reading statistics */
		const s = meta.statistics;
		if (s?.book && s.derived) {
			const m = {
				pages: s.book.pages,
				lastRead: s.derived.lastReadDate,
				firstRead: s.derived.firstReadDate,
				totalReadTime: s.book.total_read_time,
				progress: s.derived.percentComplete,
				readingStatus: s.derived.readingStatus,
				averageTimePerPage: s.derived.averageTimePerPage,
			} as const;

			for (const [k, val] of Object.entries(m) as [ProgKey, unknown][]) {
				if (!disabled.has(k) && isValid(val)) fm[k] = val;
			}
		}

		/*  4️⃣  extra custom fields */
		for (const k of extra) {
			const docPropKey = k as keyof DocProps;
			if (!disabled.has(k) && isValid(meta.docProps?.[docPropKey])) {
				fm[k] = meta.docProps?.[docPropKey];
			}
		}

		return fm as FrontmatterData;
	}

	/* --------- merge existing ↔ new ---------- */
	mergeFrontmatterData(
		existing: ParsedFrontmatter,
		meta: LuaMetadata,
		opts: FrontmatterSettings,
	): FrontmatterData {
		const theirs = this.createFrontmatterData(meta, opts);

		/* map existing friendly -> programmatic, preserving custom keys */
		const ours: Record<string, unknown> = {};
		for (const [fKey, val] of Object.entries(existing)) {
			const lowerFKey = fKey.toLowerCase();
			// Only use the reverse map if the key is a known friendly key.
			// Otherwise, use the key as-is (for custom fields like "Status").
			if (reverseMap.has(lowerFKey)) {
				const progKey = reverseMap.get(lowerFKey);
				if (progKey) {
					ours[progKey] = val;
				}
			} else {
				// Preserve custom fields with original casing
				ours[fKey] = val;
			}
		}

		const merged: Record<string, unknown> = { ...theirs, ...ours };
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

		/* ───────────────────────────────────────────────────────────────
        Preserve *custom* keys exactly as written by the user.
        (Not contained in FRIENDLY_KEY_MAP and not already copied.)
     	─────────────────────────────────────────────────────────────── */
		for (const [friendlyKey, value] of Object.entries(existing)) {
			const isStandard = friendlyKey.toLowerCase() in reverseMap;
			if (!isStandard && merged[friendlyKey] === undefined) {
				merged[friendlyKey] = value;
			}
		}

		return merged as FrontmatterData;
	}

	/* --------- YAML generation ---------- */
	formatDataToYaml(
		data: FrontmatterData | ParsedFrontmatter,
		{ useFriendlyKeys = true, sortKeys = true } = {},
	): string {
		const out: Record<string, unknown> = {};

		let entries = Object.entries(data);
		if (sortKeys) entries = entries.sort(([a], [b]) => a.localeCompare(b));

		for (const [k, raw] of entries) {
			if (raw === undefined || raw === null) continue;
			if (
				useFriendlyKeys &&
				(k === "highlightCount" || k === "noteCount") &&
				raw === 0
			)
				continue;

			const progKey = k as ProgKey;
			let value: unknown = raw;

			const formatter = metaFieldFormatters[progKey];
			if (formatter) {
				value = formatter(raw); // Safely call the formatter
			}

			const keyOut = useFriendlyKeys ? (FRIENDLY_KEY_MAP[progKey] ?? k) : k;
			if ((value !== "" || Array.isArray(value)) && value !== null) {
				out[keyOut] = value;
			}
		}

		return Object.keys(out).length ? `---\n${stringifyYaml(out)}---` : "";
	}

	generateYamlFromLuaMetadata(
		md: LuaMetadata,
		opts: FrontmatterSettings,
	): string {
		const data = this.createFrontmatterData(md, opts);
		return this.formatDataToYaml(data);
	}
}

/* helpers for formatDataToYaml */
const metaFieldFormatters: Partial<Record<ProgKey, (v: unknown) => unknown>> = {
	lastRead: (v) => {
		const dateStr = v instanceof Date ? v.toISOString() : String(v);
		return formatDateWithFormat(dateStr, "YYYY-MM-DD");
	},
	firstRead: (v) => {
		const dateStr = v instanceof Date ? v.toISOString() : String(v);
		return formatDateWithFormat(dateStr, "YYYY-MM-DD");
	},
	totalReadTime: (v) => formatStat("totalReadTime", v),
	averageTimePerPage: (v) => formatStat("averageTimePerPage", v),
	progress: (v) => formatStat("progress", v),
	readingStatus: (v) => String(v ?? ""),
	description: (v) => String(v ?? "").replace(/<[^>]+>/g, ""), // strip html
	authors: (v) => {
		if (Array.isArray(v)) return v; // Already formatted as a list of links
		if (typeof v === "string" && v.startsWith("[[")) return v; // Already a single link
		// Not formatted, so apply formatting
		const arr = splitAndTrim(String(v), /\s*[,;\n]\s*/);
		const links = arr.map((a) => `[[${a}]]`);
		return links.length === 1 ? links[0] : links;
	},
	keywords: (v) => (Array.isArray(v) ? v : splitAndTrim(String(v), /,/)),
};
