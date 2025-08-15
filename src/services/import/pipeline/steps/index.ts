import { isErr } from "src/lib/core/result";
import type { Step } from "../runner";
import type {
	ImportContext,
	ImportIO,
	StepOutcome,
	WarningCode,
} from "../types";

export const StatsStep: Step = {
	id: "stats",
	async run(ctx: ImportContext, io: ImportIO): Promise<StepOutcome> {
		const statsRes = await io.fs.getNodeStats(ctx.metadataPath);
		ctx = {
			...ctx,
			stats: isErr(statsRes)
				? null
				: {
						mtimeMs: statsRes.value.mtime.getTime(),
						size: statsRes.value.size,
					},
		};
		return { type: "continue", ctx };
	},
};

export const FastSkipStep: Step = {
	id: "fast-skip",
	async run(ctx, io) {
		if (ctx.forceReimport) {
			return { type: "continue", ctx };
		}
		if (!ctx.stats) return { type: "continue", ctx };
		const shouldProcess = await io.index.shouldProcessSource(
			ctx.metadataPath,
			{ mtime: ctx.stats.mtimeMs, size: ctx.stats.size },
			null,
		);
		if (!shouldProcess) {
			return { type: "plan", ctx, plan: { kind: "SKIP", reason: "UNCHANGED" } };
		}
		return { type: "continue", ctx };
	},
};

export const ParseEnrichStep: Step = {
	id: "parse-enrich",
	async run(ctx, io) {
		const luaMetadata = await io.parser.parseFile(ctx.sdrPath);
		if (!luaMetadata?.annotations?.length) {
			return {
				type: "plan",
				ctx,
				plan: { kind: "SKIP", reason: "NO_ANNOTATIONS" },
			};
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
			if (
				stats.book.authors &&
				stats.book.authors.trim().toLowerCase() !== "n/a"
			) {
				luaMetadata.docProps.authors = stats.book.authors;
			}
		}

		if (!luaMetadata.docProps.title) {
			const { getFileNameWithoutExt } = await import(
				"src/lib/pathing/fileNaming"
			);
			luaMetadata.docProps.title = getFileNameWithoutExt(ctx.sdrPath);
			io.log.warn(
				`Metadata missing title for ${ctx.sdrPath}, using filename as fallback.`,
			);
		}

		return { type: "continue", ctx: { ...ctx, luaMetadata, latestTs } };
	},
};

export const FinalSkipStep: Step = {
	id: "final-skip",
	async run(ctx, io) {
		if (ctx.forceReimport) {
			return { type: "continue", ctx };
		}
		if (!ctx.stats || !ctx.latestTs) return { type: "continue", ctx };
		const ok = await io.index.shouldProcessSource(
			ctx.metadataPath,
			{ mtime: ctx.stats.mtimeMs, size: ctx.stats.size },
			ctx.latestTs,
		);
		if (!ok)
			return { type: "plan", ctx, plan: { kind: "SKIP", reason: "UNCHANGED" } };
		return { type: "continue", ctx };
	},
};

export const ResolveActionStep: Step = {
	id: "resolve-action",
	async run(ctx, io) {
		if (ctx.forceNote) {
			return {
				type: "plan",
				ctx,
				plan: {
					kind: "MERGE",
					match: {
						file: ctx.forceNote,
						matchType: "updated",
						newHighlights: 0,
						modifiedHighlights: 0,
						luaMetadata: ctx.luaMetadata!,
						canMergeSafely: true,
					},
					session: ctx.session,
				},
			};
		}

		const { confidence, match } = await io.dupFinder.findBestMatch(
			ctx.luaMetadata!,
		);

		// Policy for PARTIAL confidence (scan was incomplete)
		if (confidence === "partial") {
			const choice = await io.ui.onIncompleteScan({
				title: ctx.luaMetadata!.docProps.title || "Unknown",
				existingPath: match?.file.path ?? null,
			});

			if (choice === "skip") {
				return {
					type: "plan",
					ctx,
					plan: { kind: "SKIP", reason: "USER_DECISION" },
				};
			}

			// create-new with timeout warning
			const warnedCtx: ImportContext = {
				...ctx,
				warnings: [...ctx.warnings, "duplicate-timeout"] as WarningCode[],
			};
			return {
				type: "plan",
				ctx: warnedCtx,
				plan: { kind: "CREATE", withTimeoutWarning: true },
			};
		}

		// FULL confidence policy
		if (!match) {
			return { type: "plan", ctx, plan: { kind: "CREATE" } };
		}
		return {
			type: "plan",
			ctx,
			plan: { kind: "MERGE", match, session: ctx.session },
		};
	},
};
