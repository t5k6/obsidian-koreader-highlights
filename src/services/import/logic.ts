import { normalizePath, type TFile } from "obsidian";
import { throwIfAborted } from "src/lib/concurrency/cancellation";
import { isErr } from "src/lib/core/result";
import { formatAppFailure } from "src/lib/errors";
import { bookKeyFromDocProps } from "src/lib/formatting";
import type { Diagnostic } from "src/lib/parsing/luaParser";
import { generateFileName, getFileNameWithoutExt } from "src/lib/pathing";
import { renderAnnotations } from "src/lib/template/templateCore";
import type { DuplicateHandlingSession } from "src/types";
import type {
	ExecResult,
	ExecutorIO,
	ImportContext,
	ImportPlan,
	PlannerIO,
} from "./types";

export async function planImport(
	initial: ImportContext,
	io: PlannerIO,
	opts?: { signal?: AbortSignal },
): Promise<{
	plan: ImportPlan;
	ctx: ImportContext;
	diagnostics: Diagnostic[];
}> {
	const diagnostics: Diagnostic[] = [];

	const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		throwIfAborted(opts?.signal);
		const t0 = performance?.now?.() ?? Date.now();
		const out = await fn();
		const t1 = performance?.now?.() ?? Date.now();
		diagnostics.push({
			severity: "info",
			message: `[ImportPlanner|${name}] ${(t1 - t0).toFixed(1)}ms — ${initial.metadataPath}`,
		});
		return out;
	};

	const ctx = { ...initial };

	await timed("Stats", async () => {
		const statsResult = await io.fs.getNodeStats(ctx.metadataPath);
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
	});

	if (!ctx.forceReimport && ctx.stats) {
		const shouldProcess = await timed("FastSkipCheck", () =>
			io.index.shouldProcessSource(
				ctx.metadataPath,
				{ mtime: ctx.stats!.mtimeMs, size: ctx.stats!.size },
				null,
			),
		);
		if (!shouldProcess) {
			return { plan: { kind: "SKIP", reason: "UNCHANGED" }, ctx, diagnostics };
		}
	}

	const planFromParse = await timed("Parse", async () => {
		const luaContent = await io.device.readMetadataFileContent(ctx.sdrPath);
		if (!luaContent) {
			return { plan: { kind: "SKIP", reason: "NO_ANNOTATIONS" } as const };
		}

		const parseResult = io.parser(luaContent);

		if (isErr(parseResult)) {
			diagnostics.push({
				severity: "error",
				message: `Failed to parse ${
					ctx.metadataPath
				}: ${formatAppFailure(parseResult.error)}`,
			});
			return { plan: { kind: "SKIP", reason: "NO_ANNOTATIONS" } as const };
		}

		const { meta, diagnostics: parserDiagnostics } = parseResult.value;

		diagnostics.push(...parserDiagnostics);

		ctx.luaMetadata = { ...meta, originalFilePath: ctx.sdrPath } as any;

		const lua = ctx.luaMetadata;
		if (!lua || !lua.annotations?.length) {
			return { plan: { kind: "SKIP", reason: "NO_ANNOTATIONS" } as const };
		}

		ctx.latestTs = lua.annotations.reduce<string | null>(
			(acc, a) => (!acc || a.datetime > acc ? a.datetime : acc),
			null,
		);

		await enrichWithStatistics(ctx, io);

		if (!lua.docProps.title) {
			lua.docProps.title = getFileNameWithoutExt(ctx.sdrPath);
			diagnostics.push({
				severity: "warn",
				message: `Missing title for ${ctx.sdrPath}, using filename`,
			});
		}
		return null;
	});

	if (planFromParse?.plan) {
		return { plan: planFromParse.plan, ctx, diagnostics };
	}

	const planFromDup = await timed("Duplicates", async () => {
		if (ctx.forceNote) {
			ctx.match = await io.dupFinder.analyzeExistingFile(
				ctx.forceNote,
				ctx.luaMetadata!,
			);
			ctx.confidence = "full";
			return { plan: { kind: "MERGE", match: ctx.match } as const };
		}
		const scan = await io.dupFinder.findBestMatch(ctx.luaMetadata!);
		ctx.match = scan.match;
		ctx.confidence = scan.confidence;
		if (ctx.confidence === "partial") {
			ctx.warnings.push("duplicate-timeout");
			return {
				plan: {
					kind: "AWAIT_USER_CHOICE",
					title: ctx.luaMetadata!.docProps.title || "Unknown",
					existingPath: ctx.match?.file.path ?? null,
				} as const,
			};
		}
		return null;
	});
	if (planFromDup?.plan) return { plan: planFromDup.plan, ctx, diagnostics };

	if (ctx.match) {
		const currentFolder = normalizePath(io.settings.highlightsFolder);
		const matchPath = ctx.match.file.path;

		// Handle root folder case: a file is in the root if it has no slashes.
		// A stale location is one that is NOT in the configured folder.
		const isDirectlyInRoot = !matchPath.includes("/");
		const inHighlightsFolder =
			currentFolder === ""
				? isDirectlyInRoot
				: matchPath.startsWith(`${currentFolder}/`);

		if (!inHighlightsFolder) {
			return {
				plan: { kind: "AWAIT_STALE_LOCATION_CONFIRM", match: ctx.match },
				ctx,
				diagnostics,
			};
		}
	}

	if (ctx.forceReimport) {
		return {
			plan: ctx.match
				? { kind: "MERGE", match: ctx.match }
				: { kind: "CREATE" },
			ctx,
			diagnostics,
		};
	}
	if (ctx.match) {
		const isUnchanged =
			ctx.stats &&
			!(await io.index.shouldProcessSource(
				ctx.metadataPath,
				{ mtime: ctx.stats.mtimeMs, size: ctx.stats.size },
				ctx.latestTs,
			));

		if (isUnchanged) {
			const key = bookKeyFromDocProps(ctx.luaMetadata!.docProps);
			const targetPaths = await io.index.findExistingBookFiles(key);
			if (!(await verifyTargetsExist(targetPaths, io, diagnostics))) {
				return { plan: { kind: "CREATE" }, ctx, diagnostics };
			}
			return { plan: { kind: "SKIP", reason: "UNCHANGED" }, ctx, diagnostics };
		}

		return { plan: { kind: "MERGE", match: ctx.match }, ctx, diagnostics };
	}

	return { plan: { kind: "CREATE" }, ctx, diagnostics };
}

async function enrichWithStatistics(
	ctx: ImportContext,
	io: PlannerIO,
): Promise<void> {
	const lua = ctx.luaMetadata!;
	const stats = await io.device.findBookStatistics(
		lua.docProps.title,
		lua.docProps.authors,
		lua.md5,
	);
	if (stats) {
		(lua as any).statistics = stats;
		lua.docProps.title = stats.book.title;
		if (stats.book.authors?.trim().toLowerCase() !== "n/a") {
			lua.docProps.authors = stats.book.authors;
		}
	}
}

export async function executeImportPlan(
	plan: ImportPlan,
	ctx: ImportContext,
	session: DuplicateHandlingSession,
	io: ExecutorIO,
	opts?: { signal?: AbortSignal },
): Promise<ExecResult> {
	throwIfAborted(opts?.signal);
	switch (plan.kind) {
		case "SKIP":
			return { status: "skipped", file: null };

		case "CREATE": {
			if (!ctx.luaMetadata) throw new Error("LuaMetadata required for CREATE");
			throwIfAborted(opts?.signal);
			const file = await createFromLua(ctx.luaMetadata, io, undefined, opts);
			return { status: "created", file };
		}

		case "MERGE": {
			if (!ctx.luaMetadata) throw new Error("LuaMetadata required for MERGE");
			throwIfAborted(opts?.signal);
			const result = await io.mergeHandler.handleDuplicate(
				plan.match,
				() => renderNoteBody(ctx.luaMetadata!, io, { signal: opts?.signal }),
				session,
				undefined,
				opts,
			);
			if (result.status === "keep-both") {
				throwIfAborted(opts?.signal);
				const file = await createFromLua(ctx.luaMetadata!, io, undefined, opts);
				return { status: "created", file };
			}
			if (result.status === "skipped") return { status: "skipped", file: null };
			if (result.status === "automerged")
				return { status: "automerged", file: result.file! };
			return { status: result.status, file: result.file! } as Extract<
				ExecResult,
				{ status: "merged" | "created" }
			>;
		}
		case "AWAIT_STALE_LOCATION_CONFIRM":
		case "AWAIT_USER_CHOICE":
			throw new Error("AWAIT_USER_CHOICE must be resolved before execution.");
	}
}

async function renderNoteBody(
	lua: import("src/types").LuaMetadata,
	io: ExecutorIO,
	opts?: { signal?: AbortSignal },
): Promise<string> {
	try {
		throwIfAborted(opts?.signal);

		// 1. Call the new, pure, Result-based method.
		const compiledResult = await io.templateManager.getCompiledTemplateResult();

		// 2. Handle the failure case explicitly. This makes our shell robust.
		if (isErr(compiledResult)) {
			// Propagate a descriptive error to be caught by the pipeline orchestrator.
			throw new Error(
				`Template rendering failed: ${formatAppFailure(compiledResult.error)}`,
			);
		}

		// 3. On success, unwrap the value.
		const compiled = compiledResult.value;

		throwIfAborted(opts?.signal);
		const s = io.settings;
		return renderAnnotations(
			lua.annotations ?? [],
			compiled,
			s.commentStyle,
			s.maxHighlightGap,
		);
	} catch (err: any) {
		const logger = io.log.scoped("ImportExecutorService");
		logger.error("Failed to render note body", {
			title: lua.docProps.title,
			err,
		});
		// Re-throw the original or a wrapped error.
		throw new Error(`Body rendering failed: ${err?.message ?? String(err)}`);
	}
}

async function createFromLua(
	lua: import("src/types").LuaMetadata,
	io: ExecutorIO,
	bodyProvider?: () => Promise<string>,
	opts?: { signal?: AbortSignal },
): Promise<TFile> {
	const s = io.settings;

	// --- Content Generation (Functional Core) ---
	throwIfAborted(opts?.signal);
	const body = bodyProvider
		? await bodyProvider()
		: await renderNoteBody(lua, io, opts);

	// Note: We generate frontmatter WITHOUT a UID initially.
	const fm = (
		await import("src/services/parsing/FrontmatterService")
	).FrontmatterService.createFrontmatterData(lua, s.frontmatter);
	const content = io.fmService.reconstructFileContent(fm, body);

	const fileNameWithExt = generateFileName(
		{
			useCustomTemplate: s.useCustomFileNameTemplate,
			template: s.fileNameTemplate,
		},
		lua.docProps,
		lua.originalFilePath ?? undefined,
	);
	const baseStem = getFileNameWithoutExt(fileNameWithExt);

	// --- File Creation (Stateful Shell) ---
	throwIfAborted(opts?.signal);
	const file = await io.fs.createVaultFileUnique(
		s.highlightsFolder,
		baseStem,
		content,
	);

	// --- Persistence Delegation (Stateful Shell) ---
	// Delegate all persistence logic to the new service.
	throwIfAborted(opts?.signal);

	// 1. Atomically assign a UID to the new file.
	const idResult = await io.persistence.ensureId(file);

	// 2. Best-effort create a snapshot for future merges.
	if (!isErr(idResult)) {
		const uid = idResult.value;
		const snapshotResult = await io.persistence.createSnapshotFromContent(
			uid,
			content,
		);
		if (isErr(snapshotResult)) {
			io.log.warn(
				"Snapshot creation failed for new file (continuing without baseline)",
				{ path: file.path, error: snapshotResult.error },
			);
		}
	} else {
		io.log.error(
			"Failed to assign UID to newly created file. Snapshots will be unavailable for this note.",
			{ path: file.path, error: idResult.error },
		);
	}

	return file;
}

async function verifyTargetsExist(
	paths: string[],
	io: PlannerIO,
	diagnostics: Diagnostic[],
): Promise<boolean> {
	for (const path of paths) {
		const existsResult = await io.fs.vaultExists(path);
		if (isErr(existsResult) || !existsResult.value) {
			diagnostics.push({
				severity: "info",
				message: `Index pointed to missing note at '${path}'. Cleaning up.`,
			});
			await io.index.deleteBookInstanceByPath(path).catch(() => {});
			return false;
		}
	}
	return true;
}
