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
import { deepCanonicalize, deepEqual } from "./core/objectUtils";
import { hasValue } from "./core/validationUtils";
import { formatDateResult } from "./formatting";
import { formatDurationHms, formatShortDuration } from "./formatting/dateUtils";
import { FRONTMATTER_REGEX, parseFrontmatter } from "./frontmatter";
import { formatConflictRegions, performDiff3 } from "./merge/diffCore";
import { parseBookMetadataFields } from "./parsing/fieldParsers";
import { Pathing } from "./pathing";
import { splitAndTrim, stripHtml } from "./strings/stringUtils";

// Define a logger interface for the functional core
export interface LoggerLike {
	error(message: string, error?: unknown): void;
	warn(message: string, context?: unknown): void;
	info(message: string, context?: unknown): void;
}

// Default no-op logger for optional injection (or if not provided)
const NO_OP_LOGGER: LoggerLike = {
	error: () => {},
	warn: () => {},
	info: () => {},
};

// Derive ProgKey from the concrete FrontmatterData to avoid manual sync
type ProgKey = keyof FrontmatterData;

type InternalFrontmatter = {
	"kohl-uid"?: string;
	"last-merged"?: string;
	sha256?: string;
	conflicts?: "unresolved" | "resolved";
};

type ExtFrontmatter = Partial<FrontmatterData> & Partial<InternalFrontmatter>;

// Use a utility to safely assign properties without 'any'
function assignProperty<T extends object, K extends PropertyKey, V>(
	obj: T,
	key: K,
	value: V,
): T & Record<K, V> {
	Object.assign(obj, { [key]: value });
	return obj as T & Record<K, V>;
}

function normalizeKeySet(keys?: string[]): Set<keyof FrontmatterData> {
	return new Set(
		(keys ?? []).map((k) => normalizeField(k) as keyof FrontmatterData),
	);
}

function toPersistedCanonical(data: Record<string, unknown>) {
	const canonical: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || value === null) continue;
		const canonicalKey = normalizeField(key);
		if (
			canonicalKey === "kohl-uid" ||
			canonicalKey === "last-merged" ||
			canonicalKey === "sha256"
		)
			continue;
		canonical[canonicalKey] = deepCanonicalize(value);
	}
	return canonical;
}

const FRONTMATTER_KEY_ORDER: ProgKey[] = [
	// Bibliographic
	"title",
	"authors",
	"description",
	"keywords",
	"series",
	"language",
	"pages",

	// Reading stats
	"readingStatus",
	"progress",
	"firstRead",
	"lastRead",
	"totalReadTime",
	"averageTimePerPage",
	"highlightCount",
	"noteCount",
];

const ORDERED_KEY_SET = new Set(FRONTMATTER_KEY_ORDER);

import { err, isErr, ok, type Result } from "./core/result";
import type { ParseFailure } from "./errors/types";

export type ParsedNote = Result<
	{ frontmatter: Record<string, unknown>; body: string },
	ParseFailure
>;

export type MergeStrategy =
	| "overwrite"
	| "preserveIfMissing"
	| "preserveAlways";

// Pure policy applicator
export function applyMergePolicy(
	key: keyof FrontmatterData,
	oldValue: unknown,
	newValue: unknown,
	strategy: MergeStrategy,
): unknown {
	switch (strategy) {
		case "overwrite":
			return hasValue(newValue) ? newValue : oldValue;
		case "preserveIfMissing":
			return hasValue(oldValue) ? oldValue : newValue;
		case "preserveAlways":
			return oldValue;
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

type SnapshotState =
	| { kind: "valid"; content: string }
	| { kind: "empty" }
	| { kind: "missing" };

function getSnapshotState(body: string | null): SnapshotState {
	if (body === null) return { kind: "missing" };
	if (body.trim() === "") return { kind: "empty" };
	return { kind: "valid", content: body };
}

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
	const disabled = normalizeKeySet(opts.disabledFields);
	const extra = normalizeKeySet(opts.customFields);

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
	if (!disabled.has("highlightCount")) assignProperty(fm, "highlightCount", hl);
	if (!disabled.has("noteCount")) assignProperty(fm, "noteCount", notes);

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
			unknown,
		][]) {
			if (!disabled.has(k) && hasValue(val)) {
				assignProperty(fm, k as keyof FrontmatterData, val);
			}
		}
	}

	// extra custom fields
	for (const k of extra) {
		const docPropKey = k as keyof DocProps;
		if (!disabled.has(k) && hasValue(meta.docProps?.[docPropKey])) {
			assignProperty(fm, k, meta.docProps?.[docPropKey]);
		}
	}

	if (uid) {
		assignProperty(fm, KOHL_UID_KEY, uid);
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
	const existingCanon: ExtFrontmatter = {};
	for (const [k, v] of Object.entries(existing)) {
		const canon = normalizeField(k) as keyof FrontmatterData;
		assignProperty(existingCanon, canon, v);
	}

	// Default policies
	type PolicyMap = { [K in keyof FrontmatterData]?: MergeStrategy };

	const MERGE_POLICIES: PolicyMap = {
		lastRead: "overwrite",
		firstRead: "overwrite",
		totalReadTime: "overwrite",
		progress: "overwrite",
		readingStatus: "overwrite",
		averageTimePerPage: "overwrite",
		highlightCount: "overwrite",
		noteCount: "overwrite",
		pages: "overwrite",

		title: "preserveIfMissing",
		authors: "preserveIfMissing",
		description: "preserveIfMissing",
		keywords: "preserveIfMissing",
		series: "preserveIfMissing",
		language: "preserveIfMissing",
	};

	const effectivePolicies: PolicyMap = { ...MERGE_POLICIES };

	const disabled = normalizeKeySet(opts.disabledFields);
	for (const key of disabled) {
		effectivePolicies[key] = "preserveAlways";
	}

	const custom = normalizeKeySet(opts.customFields);
	for (const key of custom) {
		if (!effectivePolicies[key]) {
			effectivePolicies[key] = "preserveIfMissing";
		}
	}

	const allKeys = new Set<keyof FrontmatterData>([
		...(Object.keys(existingCanon) as (keyof FrontmatterData)[]),
		...(Object.keys(incoming) as (keyof FrontmatterData)[]),
	]);

	const merged: Partial<FrontmatterData> = {};
	for (const key of allKeys) {
		const strategy = effectivePolicies[key] ?? "preserveAlways";
		assignProperty(
			merged,
			key,
			applyMergePolicy(key, existingCanon[key], incoming[key], strategy),
		);
	}

	assignProperty(merged, "title", merged.title ?? "");
	assignProperty(
		merged,
		"authors",
		merged.authors ?? (opts.useUnknownAuthor ? "Unknown Author" : ""),
	);

	const existingUid = (existing as Record<string, unknown>)[KOHL_UID_KEY];
	if (typeof existingUid === "string") {
		assignProperty(
			merged as Record<string, unknown>,
			KOHL_UID_KEY,
			existingUid,
		);
	}

	return merged as FrontmatterData;
}

type FieldFormatter = (value: unknown, opts: FrontmatterSettings) => unknown;

const FIELD_FORMATTERS: Record<ProgKey, FieldFormatter | undefined> = {
	lastRead: (rawValue) => {
		const r = formatDateResult(String(rawValue), "{YYYY}-{MM}-{DD}");
		return r.ok ? r.value : "";
	},
	firstRead: (rawValue) => {
		const r = formatDateResult(String(rawValue), "{YYYY}-{MM}-{DD}");
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
		if (Array.isArray(rawValue)) return rawValue;
		if (typeof rawValue === "string" && rawValue.startsWith("[["))
			return rawValue;
		const arr = splitAndTrim(String(rawValue), /\s*[,;&\n]\s*/);
		const links = arr.map((a) => {
			const escaped = a.replace(/([[\]|#^])/g, "\\$1");
			return `[[${escaped}]]`;
		});
		return links.length === 1 ? links[0] : links;
	},
	keywords: (rawValue) =>
		Array.isArray(rawValue) ? rawValue : splitAndTrim(String(rawValue), /,/),
	description: (rawValue) => stripHtml(String(rawValue ?? "")),
	// other fields can be undefined, or simple pass-through.
};

// Consolidated function for checking if a field should be included in output
function shouldIncludeDisplayField(progKey: ProgKey, value: unknown): boolean {
	if (value == null) return false;
	if (typeof value === "string" && value.trim() === "") return false;
	if ((progKey === "highlightCount" || progKey === "noteCount") && value === 0)
		return false;
	return true;
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
	const disabled = normalizeKeySet(opts.disabledFields);

	for (const [key, rawValue] of Object.entries(data)) {
		const canonical = normalizeField(key);
		const progKey = (canonical ?? key) as ProgKey;

		if (disabled.has(progKey)) continue;

		let value = rawValue;
		const formatter = FIELD_FORMATTERS[progKey];
		if (formatter) {
			value = formatter(rawValue, opts); // Pass opts if formatters need them
		}

		if (shouldIncludeDisplayField(progKey, value)) {
			const outKey =
				canonical in FIELD_FORMATTERS ||
				ORDERED_KEY_SET.has(canonical as ProgKey)
					? canonical
					: key;
			output[outKey] = value;
		}
	}
	return output;
}

/**
 * [CORE] Converts a frontmatter object into a YAML string with stable key ordering.
 * Returns a Result to handle YAML serialization errors gracefully.
 */
export function stringifyFrontmatter(
	data: Record<string, unknown>,
): Result<string, ParseFailure> {
	if (!data || Object.keys(data).length === 0) return ok("");

	// 1. Normalize all input keys to their canonical form first.
	const canonicalData: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined || value === null) continue;

		// Filter internal-only fields during normalization.
		const canonicalKey = normalizeField(key);
		if (
			canonicalKey === "kohl-uid" ||
			canonicalKey === "last-merged" ||
			canonicalKey === "sha256"
		) {
			continue;
		}
		canonicalData[canonicalKey] = value;
	}

	if (Object.keys(canonicalData).length === 0) return ok("");

	// 2. Sort the CANONICAL keys based on the predefined order.
	const sortedKeys = Object.keys(canonicalData).sort((a, b) => {
		const aIsOrdered = ORDERED_KEY_SET.has(a as ProgKey);
		const bIsOrdered = ORDERED_KEY_SET.has(b as ProgKey);

		if (aIsOrdered && bIsOrdered) {
			return (
				FRONTMATTER_KEY_ORDER.indexOf(a as ProgKey) -
				FRONTMATTER_KEY_ORDER.indexOf(b as ProgKey)
			);
		}
		if (aIsOrdered) return -1; // a comes first
		if (bIsOrdered) return 1; // b comes first

		// Fallback for non-ordered keys is alphabetical.
		return a.localeCompare(b);
	});

	// 3. Build the final object for stringification using friendly keys.
	const friendlyData: Record<string, unknown> = {};
	for (const key of sortedKeys) {
		const friendlyKey = toFriendlyField(key);
		friendlyData[friendlyKey] = deepCanonicalize(canonicalData[key]);
	}

	try {
		const yamlContent = stringifyYaml(friendlyData).trim();
		// Handle empty YAML content explicitly for reconstruction.
		// stringifyYaml returns 'null\n' for empty objects which is not ideal.
		if (yamlContent === "null") return ok(""); // Explicitly return empty string for empty frontmatter
		return ok(yamlContent);
	} catch (e) {
		return err({
			kind: "YamlParseError",
			message: (e as Error).message,
		});
	}
}

/**
 * [CORE] Reconstructs full note content from frontmatter and a body string.
 */
export function reconstructNoteContent(
	frontmatter: Record<string, unknown>,
	body: string,
	logger?: LoggerLike,
): string {
	const yamlResult = stringifyFrontmatter(frontmatter);
	if (isErr(yamlResult)) {
		(logger ?? NO_OP_LOGGER).error(
			"Failed to stringify frontmatter during reconstruction",
			yamlResult.error,
		);
		return (body || "").trim(); // Fallback to body only
	}
	const yamlString = yamlResult.value;
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

	const authorSlug = Pathing.toMatchKey(authors);
	const titleSlug = Pathing.toMatchKey(title);

	const key = `${authorSlug}::${titleSlug}`;

	return { title, authors, key, vaultPath };
}

export function areFrontmattersEqual(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	logger?: LoggerLike,
): boolean {
	try {
		return deepEqual(toPersistedCanonical(a), toPersistedCanonical(b));
	} catch (e) {
		(logger ?? NO_OP_LOGGER).error("Error comparing frontmatters", e);
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
	const fileNameWithExt = Pathing.generateFileName(
		{
			useCustomTemplate: settings.useCustomFileNameTemplate,
			template: settings.fileNameTemplate,
		},
		lua.docProps,
		lua.originalFilePath ?? undefined,
	);
	const baseStem = Pathing.getFileNameWithoutExt(fileNameWithExt);

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
	const frontmatter = mergeFrontmatter({}, lua, fmSettings);
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
		// Merge raw frontmatter with latest KOReader metadata
		const rawFrontmatter = mergeFrontmatter(
			currentDoc.frontmatter,
			lua,
			fmSettings,
		);
		// Apply display formatting so replace has the same behavior as create/merge
		const displayFrontmatter = formatFrontmatterDataForDisplay(
			rawFrontmatter,
			fmSettings,
		);
		return { frontmatter: displayFrontmatter, body: renderedBody };
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
	logger?: LoggerLike;
}): Result<MergePreparation, ParseFailure> {
	const {
		baseSnapshotBody,
		incomingBody,
		lua,
		settings,
		logger = NO_OP_LOGGER,
	} = params;

	const snapshotState = getSnapshotState(baseSnapshotBody);
	let effectiveBaseBody: string;
	let snapshotUsedForMerge: boolean;
	let diagnostics: { reason: string; userMessage?: string } | undefined;

	switch (snapshotState.kind) {
		case "valid":
			effectiveBaseBody = snapshotState.content;
			snapshotUsedForMerge = true;
			break;
		case "empty":
			logger.warn(
				"prepareForMerge: Base snapshot was empty. Treating as empty baseline.",
			);
			effectiveBaseBody = "";
			snapshotUsedForMerge = false;
			diagnostics = {
				reason:
					"Base snapshot was empty; treating as full conflict to preserve user data",
				userMessage:
					"This merge shows all changes as conflicts because the plugin couldn't find a valid baseline. This ensures no data is lost - please review and resolve manually.",
			};
			break;
		case "missing":
			logger.warn(
				"prepareForMerge: No base snapshot found. Treating as empty baseline.",
			);
			effectiveBaseBody = "";
			snapshotUsedForMerge = false;
			diagnostics = {
				reason:
					"No base snapshot found; treating as full conflict to preserve user data",
				userMessage:
					"This merge shows all changes as conflicts because the plugin couldn't find a valid baseline. This ensures no data is lost - please review and resolve manually.",
			};
			break;
	}

	const baseDoc = parseNoteContent(effectiveBaseBody);
	if (isErr(baseDoc)) {
		logger.error(
			"prepareForMerge: Failed to parse effective base body",
			baseDoc.error,
		);
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

		assignProperty(
			rawMergedFm,
			"last-merged",
			new Date().toISOString().slice(0, 10),
		);
		if (
			hasConflict ||
			!snapshotUsedForMerge ||
			snapshotState.kind !== "valid"
		) {
			assignProperty(rawMergedFm, "conflicts", "unresolved");
		}

		const displayFm = formatFrontmatterDataForDisplay(
			rawMergedFm,
			settings.frontmatter,
		);

		return { frontmatter: displayFm, body: mergedBody };
	};

	if (diagnostics) {
		return ok({
			kind: "conflicted",
			updater,
			snapshotUsed: snapshotUsedForMerge,
			diagnostics,
		});
	}
	return ok({ kind: "safe", updater, snapshotUsed: snapshotUsedForMerge });
}
