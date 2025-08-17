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
import { NoteIdentityService } from "../vault/NoteIdentityService";
import { FieldMappingService } from "./FieldMappingService";

/* ------------------------------------------------------------------ */
/*               1.  Key mapping / helpers (typed)                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*               1.a  Merge policy types                              */
/* ------------------------------------------------------------------ */

type MergePolicy =
	| { kind: "overwrite" }
	| { kind: "preserveIfMissing" }
	| { kind: "preserveAlways" }
	| { kind: "custom"; fn: (oldValue: any, newValue: any) => any };

type PolicyMap = {
	[K in keyof FrontmatterData]?: MergePolicy;
};

/* ------------------------------------------------------------------ */
/*               1.b  Default merge policies                          */
/* ------------------------------------------------------------------ */

const MERGE_POLICIES: PolicyMap = {
	// Statistics should be overwritten with new, valid data.
	lastRead: { kind: "overwrite" },
	firstRead: { kind: "overwrite" },
	totalReadTime: { kind: "overwrite" },
	progress: { kind: "overwrite" },
	readingStatus: { kind: "overwrite" },
	averageTimePerPage: { kind: "overwrite" },
	highlightCount: { kind: "overwrite" },
	noteCount: { kind: "overwrite" },
	pages: { kind: "overwrite" },

	// Core metadata should be preserved if it already exists.
	title: { kind: "preserveIfMissing" },
	authors: { kind: "preserveIfMissing" },
	description: { kind: "preserveIfMissing" },
	keywords: { kind: "preserveIfMissing" },
	series: { kind: "preserveIfMissing" },
	language: { kind: "preserveIfMissing" },
};

/* ------------------------------------------------------------------ */
/*               2.  Value normalisers / formatters                   */
/* ------------------------------------------------------------------ */

/**
 * Checks if a value is valid for frontmatter inclusion.
 * @param value - Value to check
 * @returns True if value is not null/undefined/empty string
 */
/**
 * Returns true if a value is considered “present” for front-matter.
 * Unlike the old `isValid`, this correctly treats `0` and `false` as valid values.
 */
function hasValue(v: unknown): boolean {
	if (v === undefined || v === null) return false;
	if (typeof v === "string" && v.trim() === "") return false;
	if (Array.isArray(v) && v.length === 0) return false;
	return true;
}

/**
 * Applies a single merge policy to one field, determining the final value.
 * @param key The key of the field being processed.
 * @param existingFm The existing frontmatter object.
 * @param incomingFm The new frontmatter object from KOReader.
 * @param policy The merge policy to apply for this key.
 * @returns The resulting value for the key.
 */
function applyPolicy(
	key: keyof FrontmatterData,
	existingFm: Partial<FrontmatterData>,
	incomingFm: Partial<FrontmatterData>,
	policy: MergePolicy,
): any {
	const oldValue = existingFm[key];
	const newValue = incomingFm[key];

	switch (policy.kind) {
		case "overwrite":
			// Only write the new value if it's considered valid. Otherwise, keep the old one.
			return hasValue(newValue) ? newValue : oldValue;

		case "preserveIfMissing":
			// If an old value exists, keep it. Only write the new value if there was no old one.
			return hasValue(oldValue) ? oldValue : newValue;

		case "preserveAlways":
			// Always keep the old value, ignoring the new one.
			return oldValue;

		case "custom":
			// Delegate to the custom function.
			return policy.fn(oldValue, newValue);
	}
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
		uid?: string,
	): FrontmatterData {
		const fm: Partial<FrontmatterData> = {};
		const disabled = new Set(opts.disabledFields ?? []);
		const extra = new Set(opts.customFields ?? []);

		/*  1️ DocProps */
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
				lastRead: s.derived.lastReadDate?.toISOString(),
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
				if (!disabled.has(k) && hasValue(val)) {
					fm[k] = val;
				}
			}
		}

		/*  4️  extra custom fields */
		for (const k of extra) {
			const docPropKey = k as keyof DocProps;
			if (!disabled.has(k) && hasValue(meta.docProps?.[docPropKey])) {
				fm[k as keyof FrontmatterData] = meta.docProps?.[docPropKey] as any;
			}
		}

		// If caller provided a UID, include it so notes are born with a stable identity.
		if (uid) {
			(fm as any)[NoteIdentityService.UID_KEY] = uid;
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
		const incoming = this.createFrontmatterData(meta, opts);

		const existingCanon: Partial<FrontmatterData> = {};
		for (const [k, v] of Object.entries(existing)) {
			const canon = FieldMappingService.normalize(k) as keyof FrontmatterData;
			(existingCanon as any)[canon] = v;
		}

		// 1) Build effective policy map, respecting user settings.
		const effectivePolicies: PolicyMap = { ...MERGE_POLICIES };

		// Disabled fields are preserved always.
		const disabled = new Set(opts.disabledFields ?? []);
		for (const key of disabled) {
			effectivePolicies[key as keyof FrontmatterData] = {
				kind: "preserveAlways",
			};
		}

		// Custom/user-defined extra fields should be preserved if no explicit policy.
		const custom = new Set(opts.customFields ?? []);
		for (const key of custom) {
			if (!effectivePolicies[key as keyof FrontmatterData]) {
				effectivePolicies[key as keyof FrontmatterData] = {
					kind: "preserveAlways",
				};
			}
		}

		// 2) Determine all keys present in either existing or incoming.
		const allKeys = new Set<keyof FrontmatterData>([
			...(Object.keys(existingCanon) as (keyof FrontmatterData)[]),
			...(Object.keys(incoming) as (keyof FrontmatterData)[]),
		]);

		const merged: Partial<FrontmatterData> = {};
		for (const key of allKeys) {
			const policy = effectivePolicies[key] ?? { kind: "preserveAlways" };
			// Use the normalized existingCanon object here
			const finalValue = applyPolicy(key, existingCanon, incoming, policy);
			if (hasValue(finalValue)) {
				(merged as any)[key] = finalValue;
			}
		}

		// 4) Guarantee presence of required fields with fallbacks.
		merged.title ??= "";
		merged.authors ??= opts.useUnknownAuthor ? "Unknown Author" : "";

		const existingUid = existingCanon[NoteIdentityService.UID_KEY];
		if (existingUid && typeof existingUid === "string") {
			(merged as any)[NoteIdentityService.UID_KEY] = existingUid;
		}

		return merged as FrontmatterData;
	}
}
