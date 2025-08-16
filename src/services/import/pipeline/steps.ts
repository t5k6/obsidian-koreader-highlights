import { isErr } from "src/lib/core/result";
import { getFileNameWithoutExt } from "src/lib/pathing/fileNaming";
import type { ImportContext, ImportPlan, PlannerIO } from "./types";

type Step = (
	ctx: ImportContext,
	io: PlannerIO,
) => Promise<
	| { kind: "continue"; ctx: ImportContext }
	| { kind: "decide"; ctx: ImportContext; plan: ImportPlan }
>;

export const StatsStep: Step = async (ctx: ImportContext, io: PlannerIO) => {
	const stRes = await io.fs.getNodeStats(ctx.metadataPath);
	if (isErr(stRes)) {
		io.log.warn?.(`StatsStep: cannot stat ${ctx.metadataPath}`);
		return { kind: "continue", ctx: { ...ctx, stats: null } };
	}
	const s = stRes.value;
	return {
		kind: "continue",
		ctx: { ...ctx, stats: { mtimeMs: s.mtime.getTime(), size: s.size } },
	};
};

export const FastSkipStep: Step = async (ctx, io) => {
	if (ctx.forceReimport || !ctx.stats) return { kind: "continue", ctx };
	await io.index.whenReady();
	const ok = await io.index.shouldProcessSource(
		ctx.metadataPath,
		{ mtime: ctx.stats.mtimeMs, size: ctx.stats.size },
		null,
	);
	if (!ok) {
		const plan = { kind: "SKIP", reason: "UNCHANGED" } as const;
		return { kind: "decide", ctx, plan };
	}
	return { kind: "continue", ctx };
};

export const ParseEnrichStep: Step = async (ctx, io) => {
	// Prefer parser.parseFile which reads via SDRFinder internally and returns LuaMetadata | null
	const luaMetadata = await io.parser.parseFile(ctx.sdrPath);
	if (!luaMetadata) {
		io.log.warn?.(`parse: failed to read/parse metadata at ${ctx.sdrPath}`);
		const plan = { kind: "SKIP", reason: "NO_ANNOTATIONS" } as const;
		return { kind: "decide", ctx, plan };
	}

	if (!luaMetadata.annotations || luaMetadata.annotations.length === 0) {
		io.log.info?.(`Skipping ${ctx.metadataPath}: No highlights`);
		const plan = { kind: "SKIP", reason: "NO_ANNOTATIONS" } as const;
		return { kind: "decide", ctx: { ...ctx, luaMetadata }, plan };
	}

	const latestTs = luaMetadata.annotations.reduce<string | null>(
		(acc, a) => (!acc || a.datetime > acc ? a.datetime : acc),
		null,
	);

	const stats = await io.statsSvc.findBookStatistics(
		luaMetadata.docProps.title,
		luaMetadata.docProps.authors,
		luaMetadata.md5,
	);
	if (stats) {
		luaMetadata.statistics = stats;
		luaMetadata.docProps.title = stats.book.title;
		if (stats.book.authors?.trim().toLowerCase() !== "n/a") {
			luaMetadata.docProps.authors = stats.book.authors;
		}
	}

	if (!luaMetadata.docProps.title) {
		luaMetadata.docProps.title = getFileNameWithoutExt(ctx.sdrPath);
		io.log.warn?.(`Missing title for ${ctx.sdrPath}, using filename`);
	}

	return { kind: "continue", ctx: { ...ctx, luaMetadata, latestTs } };
};

export const FinalSkipStep: Step = async (ctx, io) => {
	if (ctx.forceReimport || !ctx.stats || !ctx.latestTs)
		return { kind: "continue", ctx };
	await io.index.whenReady();
	const ok = await io.index.shouldProcessSource(
		ctx.metadataPath,
		{ mtime: ctx.stats.mtimeMs, size: ctx.stats.size },
		ctx.latestTs,
	);
	if (!ok) {
		const plan = { kind: "SKIP", reason: "UNCHANGED" } as const;
		return { kind: "decide", ctx, plan };
	}
	return { kind: "continue", ctx };
};

export const ResolveActionStep: Step = async (ctx, io) => {
	if (ctx.forceNote) {
		const plan = {
			kind: "MERGE",
			match: {
				file: ctx.forceNote,
				matchType: "updated",
				newHighlights: 0,
				modifiedHighlights: 0,
				luaMetadata: ctx.luaMetadata!,
				canMergeSafely: true,
			},
		} as const;
		return { kind: "decide", ctx, plan };
	}

	const { confidence, match } = await io.dupFinder.findBestMatch(
		ctx.luaMetadata!,
	);

	if (confidence === "partial") {
		const plan = {
			kind: "AWAIT_USER_CHOICE",
			title: ctx.luaMetadata?.docProps.title || "Unknown",
			existingPath: match?.file.path ?? null,
		} as const;
		return { kind: "decide", ctx, plan };
	}

	if (!match) {
		const plan = { kind: "CREATE" } as const;
		return { kind: "decide", ctx, plan };
	}

	const plan = { kind: "MERGE", match } as const;
	return { kind: "decide", ctx, plan };
};
