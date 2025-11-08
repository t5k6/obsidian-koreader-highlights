import type { TFile } from "obsidian";
import { throwIfAborted } from "src/lib/concurrency/cancellation";
import { isErr, ok, type Result } from "src/lib/core/result";
import { timed } from "src/lib/core/timing";
import { IndexRepository } from "src/lib/database/indexRepository";
import type { ParseFailure } from "src/lib/errors/types";
import { bookKeyFromDocProps } from "src/lib/formatting";
import type { Diagnostic } from "src/lib/parsing/luaParser";
import { parse as parseMetadata } from "src/lib/parsing/luaParser";
import { Pathing } from "src/lib/pathing";
import type {
	DuplicateMatch,
	DuplicateScanResult,
	LuaMetadata,
} from "src/types";
import type { ImportContext, ImportPlan, PlannerIO } from "./types";

type GatheredImportData = {
	stats: { mtimeMs: number; size: number } | null;
	luaMetadata: LuaMetadata | null;
	latestTs: string | null;
	match: DuplicateMatch | null | undefined;
	confidence: DuplicateScanResult["confidence"] | undefined;
	metadataPath: string;
	reasonToSkip: "unchanged" | "unchanged-but-missing-note" | null;
	missingNotePaths: string[];
	sdrPath: string;
};

export type EnrichedImportContext = ImportContext & {
	luaMetadata: LuaMetadata;
	latestTs: string | null;
};

/**
 * Pure pre-flight function that parses lua content and enriches context with metadata.
 * Returns Result with success or ParseFailure.
 */
import type { BookStatisticsBundle } from "src/types";

/**
 * Pure function to parse Lua content and return metadata with diagnostics.
 * Returns Result with parsed metadata and accumulated diagnostics.
 */
export function parseLuaMetadata(
	luaContent: string,
	sdrPath: string,
): Result<{ meta: LuaMetadata; diagnostics: Diagnostic[] }, ParseFailure> {
	const parseResult = parseMetadata(luaContent);
	if (isErr(parseResult)) return parseResult;

	const { meta, diagnostics } = parseResult.value;
	const accumulatedDiagnostics = [...diagnostics];

	// Pure title fallback
	if (!meta.docProps.title) {
		meta.docProps.title = Pathing.getFileNameWithoutExt(sdrPath);
		accumulatedDiagnostics.push({
			severity: "warn",
			message: `Missing title, using filename for ${sdrPath}`,
		});
	}

	return ok({
		meta: { ...meta, originalFilePath: sdrPath },
		diagnostics: accumulatedDiagnostics,
	});
}

/**
 * Pure function to enrich LuaMetadata with statistics.
 */
export function enrichWithStatistics(
	meta: LuaMetadata,
	stats: BookStatisticsBundle | null,
): LuaMetadata {
	if (!stats) return meta;

	return {
		...meta,
		statistics: stats,
		docProps: {
			...meta.docProps,
			title: stats.book.title,
			authors:
				stats.book.authors?.trim().toLowerCase() !== "n/a"
					? stats.book.authors
					: meta.docProps.authors,
		},
	};
}

export function preFlight(
	initialCtx: ImportContext,
	luaContent: string,
	stats: BookStatisticsBundle | null,
	opts?: { signal?: AbortSignal },
): Result<
	{ ctx: EnrichedImportContext; diagnostics: Diagnostic[]; bookKey: string },
	ParseFailure
> {
	throwIfAborted(opts?.signal);

	// Parse metadata (pure function)
	const parseResult = parseLuaMetadata(luaContent, initialCtx.sdrPath);
	if (isErr(parseResult)) {
		return parseResult;
	}

	const { meta, diagnostics } = parseResult.value;

	// Enrich with statistics (pure function)
	const luaMetadata = enrichWithStatistics(meta, stats);

	const ctx: EnrichedImportContext = {
		...initialCtx,
		luaMetadata,
		latestTs:
			meta.annotations?.reduce<string | null>(
				(acc: string | null, a: { datetime: string }) =>
					!acc || a.datetime > acc ? a.datetime : acc,
				null,
			) ?? null,
	};

	const bookKey = bookKeyFromDocProps(ctx.luaMetadata.docProps);

	return ok({ ctx, diagnostics, bookKey });
}

/**
 * Pure function to determine import plan from gathered data.
 */
function determineImportAction(
	data: GatheredImportData,
	settings: PlannerIO["settings"],
): Promise<{
	plan: ImportPlan;
	diagnostics: Diagnostic[];
	indexCleanupPaths?: string[];
}> {
	const diagnostics: Diagnostic[] = [];

	if (!data.stats) {
		return Promise.resolve({
			plan: { kind: "SKIP", reason: "NO_ANNOTATIONS" },
			diagnostics,
		});
	}

	if (data.reasonToSkip === "unchanged") {
		return Promise.resolve({
			plan: { kind: "SKIP", reason: "UNCHANGED" },
			diagnostics,
		});
	}

	if (data.reasonToSkip === "unchanged-but-missing-note") {
		return Promise.resolve({
			plan: { kind: "CREATE" },
			diagnostics,
			indexCleanupPaths: data.missingNotePaths,
		});
	}

	if (data.confidence === "partial") {
		return Promise.resolve({
			plan: {
				kind: "AWAIT_USER_CHOICE",
				title: data.luaMetadata!.docProps.title || "Unknown",
				existingPath: data.match?.file.path ?? null,
			},
			diagnostics,
		});
	}

	const currentFolder = Pathing.toVaultPath(settings.highlightsFolder);
	const matchPath = data.match?.file.path ?? "";
	const isDirectlyInRoot = !matchPath.includes("/");
	const inHighlightsFolder =
		currentFolder === ""
			? isDirectlyInRoot
			: matchPath.startsWith(`${currentFolder}/`);

	if (data.match && !inHighlightsFolder) {
		return Promise.resolve({
			plan: { kind: "AWAIT_STALE_LOCATION_CONFIRM", match: data.match },
			diagnostics,
		});
	}

	if (data.match) {
		// Skip exact matches - no import needed
		if (data.match.matchType === "exact") {
			return Promise.resolve({
				plan: { kind: "SKIP", reason: "UNCHANGED" },
				diagnostics,
			});
		}
		return Promise.resolve({
			plan: { kind: "MERGE", match: data.match },
			diagnostics,
		});
	}

	if (!data.luaMetadata || !data.luaMetadata.annotations?.length) {
		return Promise.resolve({
			plan: { kind: "SKIP", reason: "NO_ANNOTATIONS" },
			diagnostics,
		});
	}

	return Promise.resolve({ plan: { kind: "CREATE" }, diagnostics });
}

async function collectMissingTargets(
	targetPaths: string[],
	fs: PlannerIO["fs"],
	signal?: AbortSignal,
): Promise<{ missingPaths: string[]; diagnostics: Diagnostic[] }> {
	if (targetPaths.length === 0) return { missingPaths: [], diagnostics: [] };
	let missingPaths: string[] = [];
	let diagnostics: Diagnostic[] = [];

	for (const p of targetPaths) {
		const existsResult = await fs.vaultExists(p);
		if (isErr(existsResult) || !existsResult.value) {
			missingPaths = [...missingPaths, p];
			diagnostics = [
				...diagnostics,
				{
					severity: "info",
					message: `Index pointed to missing note at '${p}'.`,
				},
			];
		}
	}

	return { missingPaths, diagnostics };
}

export async function planImport(
	initial: EnrichedImportContext,
	io: PlannerIO,
	degradedScanCache: Map<string, TFile[]> | null,
	opts?: { signal?: AbortSignal },
): Promise<{
	plan: ImportPlan;
	ctx: ImportContext;
	diagnostics: Diagnostic[];
}> {
	const diagnostics: Diagnostic[] = [];

	const ctx = { ...initial };

	const statsResult = await timed("Stats", () =>
		io.fs.getNodeStats(ctx.metadataPath),
	);
	if (isErr(statsResult)) {
		diagnostics.push({
			severity: "warn",
			message: `Cannot stat ${ctx.metadataPath}: ${statsResult.error}`,
		});
		ctx.stats = null;
	} else {
		ctx.stats = {
			mtimeMs: statsResult.value.mtime.getTime(),
			size: statsResult.value.size,
		};
	}

	// Skip duplicate detection for books with no annotations
	const hasAnnotations = ctx.luaMetadata.annotations?.length > 0;
	await timed(
		"Duplicates",
		async () => {
			if (!hasAnnotations) {
				// No annotations means no import needed, skip duplicate detection
				ctx.match = null;
				ctx.confidence = "full"; // Not relevant since we're skipping
				return;
			}

			if (ctx.forceNote) {
				ctx.match = await io.dupFinder.analyzeCandidateFile(
					ctx.forceNote,
					ctx.luaMetadata.annotations,
					ctx.luaMetadata,
				);
				ctx.confidence = "full";
			} else {
				const scan = await io.dupFinder.findBestMatch(
					ctx.luaMetadata,
					degradedScanCache,
				);
				ctx.match = scan.match;
				ctx.confidence = scan.confidence;
			}
		},
		diagnostics,
	);

	// --- Gather all data needed for the pure decision function ---
	let reasonToSkip: "unchanged" | "unchanged-but-missing-note" | null = null;
	let missingNotePaths: string[] = [];

	if (!ctx.forceReimport && ctx.stats) {
		const existingSource = await io.index.getImportSource(ctx.metadataPath);
		const shouldProcess = IndexRepository.shouldProcess(
			existingSource,
			{ mtime: ctx.stats.mtimeMs, size: ctx.stats.size },
			ctx.latestTs,
			ctx.luaMetadata.md5 ?? null,
		);

		if (!shouldProcess) {
			const key = bookKeyFromDocProps(ctx.luaMetadata.docProps);
			const targetPaths = await io.index.findExistingBookFiles(key);
			const { missingPaths, diagnostics: missingTargetDiagnostics } =
				await collectMissingTargets(targetPaths, io.fs, opts?.signal);
			missingNotePaths = missingPaths;
			diagnostics.push(...missingTargetDiagnostics);
			reasonToSkip =
				missingNotePaths.length > 0
					? "unchanged-but-missing-note"
					: "unchanged";
		}
	}

	// Decide phase
	const {
		plan,
		diagnostics: decisionDiagnostics,
		indexCleanupPaths,
	} = await determineImportAction(
		{
			stats: ctx.stats,
			luaMetadata: ctx.luaMetadata,
			latestTs: ctx.latestTs,
			match: ctx.match,
			confidence: ctx.confidence!,
			metadataPath: ctx.metadataPath,
			sdrPath: ctx.sdrPath,
			reasonToSkip,
			missingNotePaths,
		},
		io.settings,
	);
	diagnostics.push(...decisionDiagnostics);

	// Post-decision
	if (indexCleanupPaths) {
		ctx.indexCleanupPaths = indexCleanupPaths;
	}

	return { plan, ctx, diagnostics };
}
