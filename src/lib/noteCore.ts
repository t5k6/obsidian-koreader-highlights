/**
 * MERGE SAFETY GUARANTEE
 * ======================
 * All merge functions in this module MUST preserve user data under all conditions:
 *
 * 1. Missing snapshots → treat as empty base, create conflict markers
 * 2. Corrupt snapshots → same as missing
 * 3. Parse errors → return Result.err, NEVER throw
 * 4. Invalid input → return Result.err with details
 *
 * The only acceptable outcome when uncertain: conflict markers that preserve
 * both versions in full. Users can delete, but we cannot reconstruct.
 */

import { parseYaml, stringifyYaml } from "obsidian";
import { KOHL_UID_KEY } from "src/constants";
import {
	normalize as normalizeField, // Use an alias to avoid naming conflicts if needed
	toFriendly as toFriendlyField,
} from "src/lib/parsing/fieldMapping";
import type {
	BookMetadata,
	CommentStyle,
	DocProps,
	FrontmatterData,
	FrontmatterSettings,
	LuaMetadata,
	NoteDoc,
	NoteUpdater,
	ParsedFrontmatter,
	TemplateData,
} from "src/types";
import { deepCanonicalize } from "./core/objectUtils";
import { hasValue } from "./core/validationUtils";
import { formatDateResult, secondsToHoursMinutesSeconds } from "./formatting";
import { FRONTMATTER_REGEX, parseFrontmatter } from "./frontmatter";
import { formatConflictRegions, performDiff3 } from "./merge/diffCore";
import { parseBookMetadataFields } from "./parsing/fieldParsers";
import { generateFileName, getFileNameWithoutExt, toMatchKey } from "./pathing";
import { splitAndTrim, stripHtml } from "./strings/stringUtils";

// Create a simple logger for this module
const logger = {
	error: (message: string, error?: unknown) => {
		console.error(`[noteCore] ${message}`, error);
	},
};

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

import { err, ok, type Result } from "./core/result";
import type { ParseFailure } from "./errors/types";

export type ParsedNote = Result<
	{ frontmatter: Record<string, unknown>; body: string },
	ParseFailure
>;

export type MergePolicy =
	| { kind: "overwrite" }
	| { kind: "preserveIfMissing" }
	| { kind: "preserveAlways" }
	| { kind: "custom"; fn: (oldValue: unknown, newValue: unknown) => unknown };

// Pure policy applicator
export function applyMergePolicy(
	key: keyof FrontmatterData,
	oldValue: unknown,
	newValue: unknown,
	policy: MergePolicy,
): unknown {
	switch (policy.kind) {
		case "overwrite":
			return hasValue(newValue) ? newValue : oldValue;
		case "preserveIfMissing":
			return hasValue(oldValue) ? oldValue : newValue;
		case "preserveAlways":
			return oldValue;
		case "custom":
			return policy.fn(oldValue, newValue);
		default:
			return oldValue;
	}
}

// The explicit, typed result of a preparation function.
// Discriminated union for type safety and exhaustiveness checking.
export type MergePreparation =
	| { kind: "safe"; updater: NoteUpdater; snapshotUsed: boolean }
	| {
			kind: "conflicted";
			updater: NoteUpdater;
			snapshotUsed: boolean;
			diagnostics: { reason: string; userMessage?: string };
	  };

/**
 * [CORE] Parses a string into its frontmatter and body.
 * Returns a Result to handle YAML parsing errors explicitly.
 */
export function parseNoteContent(content: string): ParsedNote {
	const parseResult = parseFrontmatter(content);

	if (!parseResult.ok) {
		return err({
			kind: "YamlParseError",
			message: parseResult.error.message,
		});
	}

	const { yamlContent, body } = parseResult.value;

	try {
		const frontmatter =
			(parseYaml(yamlContent) as Record<string, unknown> | null) ?? {};
		return ok({ frontmatter, body: body.trim() });
	} catch (e) {
		return err({
			kind: "YamlParseError",
			message: (e as Error).message,
		});
	}
}

/**
 * [CORE] Generates frontmatter data from KOReader metadata.
 */
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

/**
 * [CORE] Merges new KOReader metadata into existing frontmatter based on defined policies.
 */
export function mergeFrontmatter(
	existing: Record<string, unknown>,
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
		(merged as any)[key] = applyMergePolicy(
			key,
			existingCanon[key],
			incoming[key],
			policy,
		);
	}

	merged.title ??= "";
	merged.authors ??= opts.useUnknownAuthor ? "Unknown Author" : "";

	const existingUid = (existingCanon as any)[KOHL_UID_KEY];
	if (existingUid && typeof existingUid === "string") {
		(merged as any)[KOHL_UID_KEY] = existingUid;
	}

	return merged as FrontmatterData;
}

/**
 * [CORE] Applies all necessary display formatting (date strings, time durations, wikilinks)
 * to raw FrontmatterData generated from KOReader metadata.
 */
export function formatFrontmatterDataForDisplay(
	data: Record<string, unknown>,
	opts: FrontmatterSettings,
): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	const disabled = new Set(opts.disabledFields ?? []);

	for (const [key, rawValue] of Object.entries(data)) {
		if (rawValue === undefined || rawValue === null) continue;

		const progKey = (normalizeField(key) ?? key) as ProgKey;

		// 1. Skip disabled fields entirely
		if (disabled.has(progKey)) continue;

		let value = rawValue;

		// 2. Apply transformations based on field type
		switch (progKey) {
			case "lastRead":
			case "firstRead": {
				const r = formatDateResult(String(rawValue), "YYYY-MM-DD");
				value = r.ok ? r.value : "";
				break;
			}
			case "totalReadTime":
			case "averageTimePerPage": {
				const n = Number(rawValue);
				value = Number.isFinite(n)
					? secondsToHoursMinutesSeconds(n)
					: String(rawValue ?? "");
				break;
			}
			case "progress": {
				const n = Number(rawValue);
				value = Number.isFinite(n)
					? `${Math.round(n)}%`
					: String(rawValue ?? "");
				break;
			}
			case "authors": {
				if (Array.isArray(rawValue)) {
					value = rawValue;
					break;
				}
				if (typeof rawValue === "string" && rawValue.startsWith("[[")) {
					value = rawValue;
					break;
				}

				const arr = splitAndTrim(String(rawValue), /\s*[,;&\n]\s*/);
				const links = arr.map((a) => {
					const escaped = a.replace(/([|#^```])/g, "\\$1");
					return `[[${escaped}]]`;
				});
				value = links.length === 1 ? links[0] : links;
				break;
			}
			case "keywords":
				value = Array.isArray(rawValue)
					? rawValue
					: splitAndTrim(String(rawValue), /,/);
				break;
			case "description":
				value = stripHtml(String(rawValue ?? ""));
				break;
		}

		// 3. Apply general field visibility rules
		if (
			(progKey === "highlightCount" || progKey === "noteCount") &&
			rawValue === 0
		) {
			continue;
		}

		if (hasValue(value)) {
			output[key] = value;
		}
	}
	return output;
}

/**
 * [CORE] Converts a frontmatter object into a sorted, formatted YAML string.
 * Assumes input data is already display-formatted - focuses only on serialization (key sorting and friendly renaming).
 */
export function stringifyFrontmatter(
	data: Record<string, unknown>,
	options: { useFriendlyKeys?: boolean; sortKeys?: boolean } = {},
): string {
	if (!data || Object.keys(data).length === 0) return "";

	const filteredData = { ...data };
	delete filteredData["kohl-uid"];
	delete (filteredData as any)["last-merged"];
	delete (filteredData as any)["sha256"];

	const { useFriendlyKeys = true, sortKeys = true } = options;
	const output: Record<string, unknown> = {};

	let entries = Object.entries(filteredData);
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

		const keyOut = useFriendlyKeys ? toFriendlyField(progKey) : key;

		// Note: No formatting logic remains here. It's now purely serialization.
		if (rawValue !== "" && (!Array.isArray(rawValue) || rawValue.length > 0)) {
			output[keyOut] = deepCanonicalize(rawValue);
		}
	}

	return Object.keys(output).length > 0 ? stringifyYaml(output) : "";
}

/**
 * [CORE] Reconstructs full note content from frontmatter and a body string.
 */
export function reconstructNoteContent(
	frontmatter: Record<string, unknown>,
	body: string,
): string {
	const yamlString = stringifyFrontmatter(frontmatter, {
		useFriendlyKeys: true,
		sortKeys: true,
	});
	if (!yamlString) return (body || "").trim();
	return `---\n${yamlString}\n---\n\n${(body || "").trim()}`;
}

/**
 * [FUNCTIONAL CORE] Pure function to extract book metadata from a frontmatter object.
 * Applies inverse formatting to handle wikilinks and markup.
 * @param fm The frontmatter object.
 * @param vaultPath The path of the file, used for the returned metadata.
 * @returns `BookMetadata` or `null` if essential fields are missing.
 */
export function extractBookMetadata(
	fm: Record<string, unknown>,
	vaultPath: string,
): BookMetadata | null {
	// Canonicalize keys first (friendly/case-insensitive -> canonical)
	const canonical: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fm)) {
		const canon = normalizeField(k);
		canonical[canon] = v;
	}

	// Parse title/authors with inverse formatting
	const { title, authors } = parseBookMetadataFields(canonical);

	if (!title && !authors) return null;

	const authorSlug = toMatchKey(authors);
	const titleSlug = toMatchKey(title);

	const key = `${authorSlug}::${titleSlug}`;

	return { title, authors, key, vaultPath };
}

export function areFrontmattersEqual(
	fm1: Record<string, unknown>,
	fm2: Record<string, unknown>,
): boolean {
	try {
		const a = stringifyFrontmatter(fm1 ?? {}, {
			useFriendlyKeys: true,
			sortKeys: true,
		});
		const b = stringifyFrontmatter(fm2 ?? {}, {
			useFriendlyKeys: true,
			sortKeys: true,
		});
		return a === b;
	} catch (error) {
		logger.error(
			"Error comparing frontmatters, assuming they are not equal",
			error,
		);
		return false;
	}
}

/**
 * [CORE] Extracts only the YAML frontmatter string from content, without the '---' delimiters.
 */
export function extractFrontmatter(content: string): string | null {
	const match = content.match(FRONTMATTER_REGEX);
	return match ? (match[1] ?? null) : null;
}

/**
 * [CORE] Strips the YAML frontmatter block from a string, returning only the body.
 */
export function stripFrontmatter(content: string): string {
	return content.replace(FRONTMATTER_REGEX, "");
}

export interface PreparedNote {
	targetFolder: string;
	baseStem: string;
	content: string;
	frontmatter: FrontmatterData;
	metadata: {
		title: string;
		authors: string;
		originalPath?: string;
	};
}

/**
 * Pure function that prepares all data needed to create a note.
 * No side effects, fully testable in isolation.
 */
export function prepareNoteCreation(
	lua: LuaMetadata,
	body: string,
	settings: {
		highlightsFolder: string;
		useCustomFileNameTemplate: boolean;
		fileNameTemplate: string;
		frontmatter: FrontmatterSettings;
	},
): PreparedNote {
	// 1. Generate raw frontmatter
	const rawFm = generateFrontmatter(lua, settings.frontmatter);

	// 2. Format for display
	const displayFm = formatFrontmatterDataForDisplay(
		rawFm,
		settings.frontmatter,
	);

	// 3. Combine formatted frontmatter and body into final content
	const content = reconstructNoteContent(displayFm, body);

	// Generate filename
	const fileNameWithExt = generateFileName(
		{
			useCustomTemplate: settings.useCustomFileNameTemplate,
			template: settings.fileNameTemplate,
		},
		lua.docProps,
		lua.originalFilePath ?? undefined,
	);
	const baseStem = getFileNameWithoutExt(fileNameWithExt);

	return {
		targetFolder: settings.highlightsFolder,
		baseStem,
		content,
		frontmatter: rawFm, // Return raw for any consumers who need it
		metadata: {
			title: lua.docProps.title,
			authors: lua.docProps.authors,
			originalPath: lua.originalFilePath,
		},
	};
}

/**
 * [CORE] Prepares a NoteUpdater for creating a new note.
 */
export function prepareForCreate(
	lua: LuaMetadata,
	renderedBody: string,
	fmSettings: FrontmatterSettings,
): MergePreparation {
	// For creation, "existing" frontmatter is an empty object.
	const frontmatter = mergeFrontmatter(
		{} as ParsedFrontmatter,
		lua,
		fmSettings,
	);
	const updater: NoteUpdater = () => ({ frontmatter, body: renderedBody });
	return { kind: "safe", updater, snapshotUsed: false };
}

/**
 * [CORE] Prepares a NoteUpdater for replacing an existing note.
 */
export function prepareForReplace(
	lua: LuaMetadata,
	renderedBody: string,
	fmSettings: FrontmatterSettings,
): MergePreparation {
	const updater: NoteUpdater = (currentDoc: NoteDoc) => {
		const frontmatter = mergeFrontmatter(
			currentDoc.frontmatter,
			lua,
			fmSettings,
		);
		return { frontmatter, body: renderedBody };
	};
	return { kind: "safe", updater, snapshotUsed: false };
}

/**
 * [CORE] Prepares a NoteUpdater for merging, always using safe 3-way merge.
 */
export function prepareForMerge(params: {
	baseSnapshotBody: string | null;
	incomingBody: string;
	lua: LuaMetadata;
	settings: {
		frontmatter: FrontmatterSettings;
		commentStyle: CommentStyle;
		maxHighlightGap: number;
	};
	compiledTemplate: (data: TemplateData) => string;
}): Result<MergePreparation, ParseFailure> {
	const { baseSnapshotBody, incomingBody, lua, settings } = params;

	// ALWAYS use 3-way merge - treat missing snapshot as empty
	const effectiveBaseBody = baseSnapshotBody ?? "";
	const baseDoc = parseNoteContent(effectiveBaseBody);

	if (!baseDoc.ok) {
		// If even empty base fails to parse, something is very wrong
		return baseDoc;
	}

	const updater: NoteUpdater = (currentDoc: NoteDoc) => {
		const regions = performDiff3(
			currentDoc.body,
			baseDoc.value.body,
			incomingBody,
		);
		let { mergedBody, hasConflict } = formatConflictRegions(regions);

		// Force conflict when incoming is empty and current has more content than base
		if (
			!hasConflict &&
			incomingBody.trim() === "" &&
			currentDoc.body.trim() !== "" &&
			currentDoc.body.length > baseDoc.value.body.length
		) {
			// Create a full conflict region
			const globalRegions = [
				{
					conflict: {
						a: currentDoc.body.split("\n"),
						aIndex: 0,
						b: [],
						bIndex: 0,
						o: baseDoc.value.body.split("\n"),
						oIndex: 0,
					},
				},
			];
			const result = formatConflictRegions(globalRegions);
			mergedBody = result.mergedBody;
			hasConflict = true;
		}

		const rawMergedFm = mergeFrontmatter(
			currentDoc.frontmatter,
			lua,
			settings.frontmatter,
		);

		(rawMergedFm as any)["last-merged"] = new Date().toISOString().slice(0, 10);
		if (hasConflict) (rawMergedFm as any).conflicts = "unresolved";

		const displayFm = formatFrontmatterDataForDisplay(
			rawMergedFm,
			settings.frontmatter,
		);

		return { frontmatter: displayFm, body: mergedBody };
	};

	const hasValidSnapshot =
		baseSnapshotBody !== null && baseSnapshotBody.trim() !== "";
	if (hasValidSnapshot) {
		return ok({ kind: "safe", updater, snapshotUsed: true });
	} else {
		return ok({
			kind: "conflicted",
			updater,
			snapshotUsed: false,
			diagnostics: {
				reason:
					"No base snapshot found or snapshot was empty; treating as full conflict to preserve user data",
				userMessage:
					"This merge shows all changes as conflicts because the plugin couldn't find a valid baseline. This ensures no data is lost - please review and resolve manually.",
			},
		});
	}
}
