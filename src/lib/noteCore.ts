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
import type {
	BookMetadata,
	CommentStyle,
	FrontmatterSettings,
	LuaMetadata,
	NoteDoc,
	NoteUpdater,
	TemplateData,
} from "src/types";
import { err, isErr, ok, type Result } from "./core/result";
import type { ParseFailure } from "./errors/types";
import { FRONTMATTER_REGEX, parseFrontmatter } from "./frontmatter";
import { mergeNoteBodies } from "./merge/mergeCore";
import { formatForDisplay } from "./metadata/formatter";
import { computeBookKey } from "./metadata/identity";
import {
	mergeNormalizedMetadata,
	normalizeBookMetadata,
	normalizeFrontmatter,
} from "./metadata/normalizer";
import { Pathing } from "./pathing";

// Define a logger interface for the functional core
export interface LoggerLike {
	error(message: string, error?: unknown): void;
	warn(message: string, context?: unknown): void;
	info(message: string, context?: unknown): void;
}

const NO_OP_LOGGER: LoggerLike = {
	error: () => {},
	warn: () => {},
	info: () => {},
};

export type ParsedNote = Result<
	{ frontmatter: Record<string, unknown>; body: string },
	ParseFailure
>;

// The explicit, typed result of a preparation function.
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
 */
export function parseNoteContent(content: string): ParsedNote {
	const parseResult = parseFrontmatter(content);
	if (!parseResult.ok) {
		return err({ kind: "YamlParseError", message: parseResult.error.message });
	}
	const { yamlContent, body } = parseResult.value;
	try {
		const frontmatter =
			(parseYaml(yamlContent) as Record<string, unknown> | null) ?? {};
		return ok({ frontmatter, body: body.trim() });
	} catch (e) {
		return err({ kind: "YamlParseError", message: (e as Error).message });
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
	// Filter out undefined/null values before stringifying
	const cleanFm: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(frontmatter)) {
		if (v !== undefined && v !== null) cleanFm[k] = v;
	}

	if (Object.keys(cleanFm).length === 0) return (body || "").trim();

	try {
		const yamlContent = stringifyYaml(cleanFm).trim();
		if (yamlContent === "null" || !yamlContent) return (body || "").trim();
		return `---\n${yamlContent}\n---\n\n${(body || "").trim()}`;
	} catch (e) {
		(logger ?? NO_OP_LOGGER).error("Failed to stringify frontmatter", e);
		return (body || "").trim();
	}
}

/**
 * [CORE] Extracts book metadata for indexing.
 */
export function extractBookMetadata(
	fm: Record<string, unknown>,
	vaultPath: string,
): BookMetadata | null {
	// Use the normalization pipeline to extract clean data
	const normalized = normalizeFrontmatter(fm);

	if (!normalized.title && normalized.authors.length === 0) return null;

	const key = computeBookKey(normalized);

	return {
		title: normalized.title,
		authors: normalized.authors.join(", "),
		key,
		vaultPath,
	};
}

export function areFrontmattersEqual(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean {
	// Simple structural equality sufficient for skipping edits
	// We rely on Obsidian's stringifyYaml to normalize order/format mostly
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

export function extractFrontmatter(content: string): string | null {
	const match = content.match(FRONTMATTER_REGEX);
	return match ? (match[1] ?? null) : null;
}

export function stripFrontmatter(content: string): string {
	return content.replace(FRONTMATTER_REGEX, "");
}

export interface PreparedNote {
	targetFolder: string;
	baseStem: string;
	content: string;
	frontmatter: Record<string, unknown>;
	metadata: {
		title: string;
		authors: string;
		originalPath?: string;
	};
}

/**
 * Pure function that prepares all data needed to create a note.
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
	// Pipeline: Normalize -> Format (No merging needed for creation)
	const normalized = normalizeBookMetadata(lua);
	const displayFm = formatForDisplay(normalized, settings.frontmatter);

	const content = reconstructNoteContent(displayFm, body);

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
		frontmatter: displayFm,
		metadata: {
			title: normalized.title,
			authors: normalized.authors.join(", "),
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
	const updater: NoteUpdater = () => {
		const normalized = normalizeBookMetadata(lua);
		const displayFrontmatter = formatForDisplay(normalized, fmSettings);
		return { frontmatter: displayFrontmatter, body: renderedBody };
	};
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
		// 1. Normalize inputs
		const currentMeta = normalizeFrontmatter(currentDoc.frontmatter);
		const newMeta = normalizeBookMetadata(lua);

		// 2. Merge logically
		const mergedMeta = mergeNormalizedMetadata(
			currentMeta,
			newMeta,
			fmSettings,
		);

		// 3. Format for display
		const displayFm = formatForDisplay(mergedMeta, fmSettings);

		// 4. Preserve Critical Identity (UID)
		if (currentDoc.frontmatter[KOHL_UID_KEY]) {
			(displayFm as any)[KOHL_UID_KEY] = currentDoc.frontmatter[
				KOHL_UID_KEY
			] as string;
		}

		return { frontmatter: displayFm, body: renderedBody };
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

	if (snapshotState.kind === "valid") {
		effectiveBaseBody = snapshotState.content;
		snapshotUsedForMerge = true;
	} else {
		logger.warn(
			`prepareForMerge: Snapshot issue (${snapshotState.kind}). using empty base.`,
		);
		effectiveBaseBody = "";
		snapshotUsedForMerge = false;
		diagnostics = {
			reason: "No base snapshot found",
			userMessage:
				"No valid snapshot found. This merge shows all changes as conflicts to ensure data safety.",
		};
	}

	const baseDoc = parseNoteContent(effectiveBaseBody);
	if (isErr(baseDoc)) {
		// Return the parse error directly for corrupt snapshots
		return err(baseDoc.error);
	}

	const updater: NoteUpdater = (currentDoc: NoteDoc) => {
		// 1. Text Merge
		const { mergedBody, hasConflict } = mergeNoteBodies(
			baseDoc.value.body,
			currentDoc.body,
			incomingBody,
		);

		// 2. Metadata Merge
		const currentMeta = normalizeFrontmatter(currentDoc.frontmatter);
		const newMeta = normalizeBookMetadata(lua);
		const mergedMeta = mergeNormalizedMetadata(
			currentMeta,
			newMeta,
			settings.frontmatter,
		);
		const displayFm = formatForDisplay(mergedMeta, settings.frontmatter);

		// 3. Metadata Housekeeping
		(displayFm as any)["last-merged"] = new Date().toISOString().slice(0, 10);
		if (hasConflict || !snapshotUsedForMerge) {
			(displayFm as any)["conflicts"] = "unresolved";
		}
		if (currentDoc.frontmatter[KOHL_UID_KEY]) {
			(displayFm as any)[KOHL_UID_KEY] = currentDoc.frontmatter[KOHL_UID_KEY];
		}

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
