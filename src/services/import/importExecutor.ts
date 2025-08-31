import { throwIfAborted } from "src/lib/concurrency/cancellation";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import { timed } from "src/lib/core/timing";
import type { AppFailure } from "src/lib/errors/types";
import { formatAppFailure } from "src/lib/errors/types";
import { prepareNoteCreation } from "src/lib/noteCore";
import { renderAnnotations } from "src/lib/templateCore";
import type { DuplicateHandlingSession } from "src/types";
import type {
	ExecResult,
	ExecutorIO,
	ImportContext,
	ImportPlan,
} from "./types";

/**
 * Executes an import plan by creating or merging notes as specified.
 */
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
			return { status: "skipped", file: null, warnings: [] };

		case "CREATE": {
			if (!ctx.luaMetadata) throw new Error("LuaMetadata required for CREATE");
			throwIfAborted(opts?.signal);

			const lua = ctx.luaMetadata;

			const bodyResult = await timed("Render", () =>
				renderNoteBody(lua, io, opts),
			);
			if (isErr(bodyResult)) {
				io.log.error("Failed to render note body", bodyResult.error);
				return { status: "skipped", file: null, warnings: [] };
			}

			const prepared = prepareNoteCreation(lua, bodyResult.value, io.settings);

			const creationResult = await timed("Create", () =>
				io.persistence.createNoteAtomically({
					folderPath: prepared.targetFolder,
					baseStem: prepared.baseStem,
					content: prepared.content,
					signal: opts?.signal,
				}),
			);

			if (isErr(creationResult)) {
				io.log.error("Failed to create note", creationResult.error);
				return { status: "skipped", file: null, warnings: [] };
			}

			const { file, warnings } = creationResult.value;

			// Mutate the context object to propagate warnings upstream.
			if (warnings && warnings.length > 0) {
				ctx.warnings.push(...warnings.map((w) => w.code));
			}

			return { status: "created", file, warnings: warnings ?? [] };
		}

		case "MERGE": {
			if (!ctx.luaMetadata) throw new Error("LuaMetadata required for MERGE");
			throwIfAborted(opts?.signal);

			const result = await io.mergeHandler.handleDuplicate(
				plan.match,
				async () => {
					const bodyResult = await renderNoteBody(ctx.luaMetadata!, io, {
						signal: opts?.signal,
					});
					if (isErr(bodyResult)) {
						throw new Error(formatAppFailure(bodyResult.error));
					}
					return bodyResult.value;
				},
				session,
				undefined,
				opts,
			);

			if (isErr(result)) {
				io.log.error("Failed to handle duplicate", result.error);
				return { status: "skipped", file: null, warnings: [] };
			}

			const mergeResult = result.value;
			if (mergeResult.status === "keep-both") {
				throwIfAborted(opts?.signal);

				const bodyResult = await timed("Render", () =>
					renderNoteBody(ctx.luaMetadata!, io, opts),
				);
				if (isErr(bodyResult)) {
					io.log.error(
						"Failed to render note body after keep-both choice",
						bodyResult.error,
					);
					return { status: "skipped", file: null, warnings: [] };
				}

				const prepared = prepareNoteCreation(
					ctx.luaMetadata!,
					bodyResult.value,
					io.settings,
				);

				const created = await timed("Create", () =>
					io.persistence.createNoteAtomically({
						folderPath: prepared.targetFolder,
						baseStem: prepared.baseStem,
						content: prepared.content,
						signal: opts?.signal,
					}),
				);

				if (isErr(created)) {
					io.log.error(
						"Failed to create note after keep-both choice",
						created.error,
					);
					return { status: "skipped", file: null, warnings: [] };
				}

				const { file, warnings } = created.value;

				if (warnings && warnings.length > 0) {
					ctx.warnings.push(...warnings.map((w) => w.code));
				}

				return { status: "created", file, warnings: warnings ?? [] };
			}

			if (mergeResult.status === "skipped")
				return { status: "skipped", file: null, warnings: [] };
			if (mergeResult.status === "automerged")
				return {
					status: "automerged",
					file: mergeResult.file!,
					warnings: [],
				};

			return {
				status: mergeResult.status,
				file: mergeResult.file!,
				warnings: [],
			};
		}
		case "AWAIT_STALE_LOCATION_CONFIRM":
		case "AWAIT_USER_CHOICE":
			throw new Error("AWAIT_USER_CHOICE must be resolved before execution.");
	}
}

/**
 * Renders the body content for a note from lua metadata.
 */
async function renderNoteBody(
	lua: import("src/types").LuaMetadata,
	io: ExecutorIO,
	opts?: { signal?: AbortSignal },
): Promise<Result<string, AppFailure>> {
	try {
		throwIfAborted(opts?.signal);

		const compiledResult = await io.templateManager.getCompiledTemplateResult();
		if (isErr(compiledResult)) {
			return err(compiledResult.error);
		}
		const compiled = compiledResult.value;

		throwIfAborted(opts?.signal);
		const s = io.settings;
		const rendered = renderAnnotations(
			lua.annotations ?? [],
			compiled,
			s.commentStyle,
			s.maxHighlightGap,
		);
		return ok(rendered);
	} catch (e: any) {
		io.log.error("Failed to render note body with unexpected error", {
			title: lua.docProps.title,
			error: e,
		});
		return err({
			kind: "TemplateParseError",
			message: `Body rendering failed unexpectedly: ${
				e instanceof Error ? e.message : String(e)
			}`,
		} as AppFailure);
	}
}
