import { type FrontMatterCache, parseYaml, stringifyYaml } from "obsidian";
import { KOHL_UID_KEY } from "src/constants";
import {
	formatDateResult,
	secondsToHoursMinutesSeconds,
} from "src/lib/formatting/dateUtils";
import { splitFrontmatter } from "src/lib/frontmatter/frontmatterUtils";
import {
	normalize as normalizeField, // Use an alias to avoid naming conflicts if needed
	toFriendly as toFriendlyField,
} from "src/lib/parsing/fieldMapping";
import { splitAndTrim, stripHtml } from "src/lib/strings/stringUtils";
import type {
	DocProps,
	FrontmatterData,
	FrontmatterSettings,
	LuaMetadata,
	ParsedFrontmatter,
} from "src/types";
import { deepCanonicalize } from "../core/objectUtils";
import { hasValue, isHms, isPercent } from "../core/validationUtils";

type ProgKey =
	| "title"
	| "authors"
	| "description"
	| "keywords"
	| "series"
	| "language"
	| "pages"
	| "highlightCount"
	| "noteCount"
	| "lastRead"
	| "firstRead"
	| "totalReadTime"
	| "progress"
	| "readingStatus"
	| "averageTimePerPage";

const metaFieldFormatters: Partial<Record<ProgKey, (v: unknown) => unknown>> = {
	lastRead: (v) => {
		const r = formatDateResult(String(v), "YYYY-MM-DD");
		return r.ok ? r.value : "";
	},
	firstRead: (v) => {
		const r = formatDateResult(String(v), "YYYY-MM-DD");
		return r.ok ? r.value : "";
	},
	totalReadTime: (v) => {
		if (isHms(v)) return v; // Already formatted
		const n = Number(v);
		return Number.isFinite(n)
			? secondsToHoursMinutesSeconds(n)
			: String(v ?? "");
	},
	averageTimePerPage: (v) => {
		if (isHms(v)) return v; // Already formatted
		const n = Number(v);
		return Number.isFinite(n)
			? secondsToHoursMinutesSeconds(n)
			: String(v ?? "");
	},
	progress: (v) => {
		if (isPercent(v)) return v; // Already formatted
		const n = Number(v);
		return Number.isFinite(n) ? `${Math.round(n)}%` : String(v ?? "");
	},
	readingStatus: (v) => String(v ?? ""),
	description: (v) => stripHtml(String(v ?? "")),
	authors: (v) => {
		if (Array.isArray(v)) return v;
		if (typeof v === "string" && v.startsWith("[[")) return v;
		const arr = splitAndTrim(String(v), /\s*[,;&\n]\s*/);
		const links = arr.map((a) => {
			const escaped = a.replace(/([|#^\]])/g, "\\$1");
			return `[[${escaped}]]`;
		});
		return links.length === 1 ? links[0] : links;
	},
	keywords: (v) => (Array.isArray(v) ? v : splitAndTrim(String(v), /,/)),
};

// --- Pure Frontmatter Logic ---

export function generateFrontmatter(
	meta: LuaMetadata,
	opts: FrontmatterSettings,
	uid?: string,
): FrontmatterData {
	const fm: Partial<FrontmatterData> = {};
	const disabled = new Set(opts.disabledFields ?? []);
	const extra = new Set(opts.customFields ?? []);

	// DocProps
	for (const [k, val] of Object.entries(meta.docProps ?? {}) as [
		keyof DocProps,
		unknown,
	][]) {
		if (!disabled.has(k) && hasValue(val)) {
			fm[k as keyof FrontmatterData] = String(val);
		}
	}

	if (!fm.title) fm.title = "";
	if (!hasValue(fm.authors) && !disabled.has("authors")) {
		fm.authors = opts.useUnknownAuthor ? "Unknown Author" : undefined;
	}

	// Highlight stats
	const hl = meta.annotations?.length ?? 0;
	const notes = meta.annotations?.filter((a) => a.note?.trim()).length ?? 0;
	if (!disabled.has("highlightCount")) fm.highlightCount = hl;
	if (!disabled.has("noteCount")) fm.noteCount = notes;

	// Reading statistics
	const s = meta.statistics;
	if (s?.book && s.derived) {
		const statsMap = {
			pages: s.book.pages,
			lastRead: s.derived.lastReadDate?.toISOString(),
			firstRead: s.derived.firstReadDate?.toISOString(),
			totalReadTime: s.book.total_read_time,
			progress: s.derived.percentComplete,
			readingStatus: s.derived.readingStatus,
			averageTimePerPage: s.derived.averageTimePerPage,
		} as const;

		for (const [k, val] of Object.entries(statsMap) as [
			keyof typeof statsMap,
			any,
		][]) {
			if (!disabled.has(k) && hasValue(val)) {
				(fm as any)[k] = val;
			}
		}
	}

	// extra custom fields
	for (const k of extra) {
		const docPropKey = k as keyof DocProps;
		if (!disabled.has(k) && hasValue(meta.docProps?.[docPropKey])) {
			(fm as any)[k] = meta.docProps?.[docPropKey] as any;
		}
	}

	if (uid) {
		(fm as any)[KOHL_UID_KEY] = uid;
	}
	return fm as FrontmatterData;
}

export function mergeFrontmatter(
	existing: ParsedFrontmatter,
	meta: LuaMetadata,
	opts: FrontmatterSettings,
): FrontmatterData {
	// Build incoming from current meta
	const incoming = generateFrontmatter(meta, opts);

	// Canonicalize existing keys
	const existingCanon: Partial<FrontmatterData> = {};
	for (const [k, v] of Object.entries(existing)) {
		const canon = normalizeField(k) as keyof FrontmatterData;
		(existingCanon as any)[canon] = v;
	}

	// Default policies
	type MergePolicy =
		| { kind: "overwrite" }
		| { kind: "preserveIfMissing" }
		| { kind: "preserveAlways" }
		| { kind: "custom"; fn: (oldValue: any, newValue: any) => any };
	type PolicyMap = { [K in keyof FrontmatterData]?: MergePolicy };

	const MERGE_POLICIES: PolicyMap = {
		lastRead: { kind: "overwrite" },
		firstRead: { kind: "overwrite" },
		totalReadTime: { kind: "overwrite" },
		progress: { kind: "overwrite" },
		readingStatus: { kind: "overwrite" },
		averageTimePerPage: { kind: "overwrite" },
		highlightCount: { kind: "overwrite" },
		noteCount: { kind: "overwrite" },
		pages: { kind: "overwrite" },

		title: { kind: "preserveIfMissing" },
		authors: { kind: "preserveIfMissing" },
		description: { kind: "preserveIfMissing" },
		keywords: { kind: "preserveIfMissing" },
		series: { kind: "preserveIfMissing" },
		language: { kind: "preserveIfMissing" },
	};

	const applyPolicy = (
		key: keyof FrontmatterData,
		existingFm: Partial<FrontmatterData>,
		incomingFm: Partial<FrontmatterData>,
		policy: MergePolicy,
	): any => {
		const oldValue = existingFm[key];
		const newValue = incomingFm[key];
		switch (policy.kind) {
			case "overwrite":
				return hasValue(newValue) ? newValue : oldValue;
			case "preserveIfMissing":
				return hasValue(oldValue) ? oldValue : newValue;
			case "preserveAlways":
				return oldValue;
			case "custom":
				return policy.fn(oldValue, newValue);
		}
	};

	const effectivePolicies: PolicyMap = { ...MERGE_POLICIES };

	const disabled = new Set(opts.disabledFields ?? []);
	for (const key of disabled) {
		effectivePolicies[key as keyof FrontmatterData] = {
			kind: "preserveAlways",
		};
	}

	const custom = new Set(opts.customFields ?? []);
	for (const key of custom) {
		if (!effectivePolicies[key as keyof FrontmatterData]) {
			effectivePolicies[key as keyof FrontmatterData] = {
				kind: "preserveIfMissing",
			};
		}
	}

	const allKeys = new Set<keyof FrontmatterData>([
		...(Object.keys(existingCanon) as (keyof FrontmatterData)[]),
		...(Object.keys(incoming) as (keyof FrontmatterData)[]),
	]);

	const merged: Partial<FrontmatterData> = {};
	for (const key of allKeys) {
		const policy = effectivePolicies[key] ?? { kind: "preserveAlways" };
		const finalValue = applyPolicy(key, existingCanon, incoming, policy);
		if (hasValue(finalValue)) {
			(merged as any)[key] = finalValue;
		}
	}

	merged.title ??= "";
	merged.authors ??= opts.useUnknownAuthor ? "Unknown Author" : "";

	const existingUid = (existingCanon as any)[KOHL_UID_KEY];
	if (existingUid && typeof existingUid === "string") {
		(merged as any)[KOHL_UID_KEY] = existingUid;
	}

	return merged as FrontmatterData;
}

export function stringifyFrontmatter(
	data: Record<string, unknown>,
	options: { useFriendlyKeys?: boolean; sortKeys?: boolean } = {},
): string {
	if (!data || Object.keys(data).length === 0) return "";

	const { useFriendlyKeys = true, sortKeys = true } = options;
	const output: Record<string, unknown> = {};

	let entries = Object.entries(data);
	if (sortKeys) entries = entries.sort(([a], [b]) => a.localeCompare(b));

	for (const [key, rawValue] of entries) {
		if (rawValue === undefined || rawValue === null) continue;

		const progKey = (normalizeField(key) ?? key) as ProgKey;

		if (
			useFriendlyKeys &&
			(progKey === "highlightCount" || progKey === "noteCount") &&
			rawValue === 0
		) {
			continue;
		}

		const formatter = metaFieldFormatters[progKey];
		const value = formatter ? formatter(rawValue) : rawValue;

		const keyOut = useFriendlyKeys ? toFriendlyField(progKey) : progKey;

		if (value !== "" && (!Array.isArray(value) || value.length > 0)) {
			output[keyOut] = deepCanonicalize(value);
		}
	}

	return Object.keys(output).length > 0 ? stringifyYaml(output) : "";
}

export function reconstructFileContent(
	frontmatter: Record<string, unknown>,
	body: string,
): string {
	const yamlString = stringifyFrontmatter(frontmatter, {
		useFriendlyKeys: true,
		sortKeys: true,
	});
	if (!yamlString) return body.trim();
	return `---\n${yamlString}---\n\n${body.trim()}`;
}

export function parseFrontmatter(content: string): {
	frontmatter: FrontMatterCache;
	body: string;
} {
	const { yaml, body } = splitFrontmatter(content);
	let frontmatter: FrontMatterCache = {};
	if (yaml) {
		try {
			frontmatter = parseYaml(yaml) ?? {};
		} catch {
			// swallow parse error, return empty fm and raw body
			frontmatter = {};
		}
	}
	return { frontmatter, body: body.trimStart() };
}
