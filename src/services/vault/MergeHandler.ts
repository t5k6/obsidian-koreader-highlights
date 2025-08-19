import { MergeResult } from "node-diff3";
import type { App, TFile } from "obsidian";
import { Notice } from "obsidian";
import { KeyedQueue, throwIfAborted } from "src/lib/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type { AppFailure, MergeFailure } from "src/lib/errors";
import { formatAppFailure } from "src/lib/errors";
import {
	formatConflictRegions,
	mergeAnnotations,
	performDiff3,
} from "src/lib/merge/mergeCore";
import { extractHighlightsWithStyle } from "src/lib/parsing/highlightExtractor";
import { renderAnnotations } from "src/lib/template/templateCore";
import type KoreaderImporterPlugin from "src/main";
import type { LoggingService } from "src/services/LoggingService";
import type {
	Annotation,
	DuplicateChoice,
	DuplicateHandlingSession,
	DuplicateMatch,
	IDuplicateHandlingModal,
	LuaMetadata,
	ParsedFrontmatter,
} from "src/types";
import {
	FrontmatterService,
	type NoteUpdater,
} from "../parsing/FrontmatterService";
import type { TemplateManager } from "../parsing/TemplateManager";
import type { NotePersistenceService } from "./NotePersistenceService";

type MergeMode = "replace" | "merge";

// Define a clear result type for a successful merge operation.
type MergeSuccessResult = {
	file: TFile;
	hasConflicts?: boolean;
};

export class MergeHandler {
	private readonly log;
	private readonly modalQueue = new KeyedQueue();
	private readonly mergeQueue = new KeyedQueue();

	constructor(
		private app: App,
		private plugin: KoreaderImporterPlugin,
		private modalFactory: (
			app: App,
			match: DuplicateMatch,
			message: string,
			session: DuplicateHandlingSession,
		) => IDuplicateHandlingModal,
		private fmService: FrontmatterService,
		private templateManager: TemplateManager,
		private persistence: NotePersistenceService,
		private loggingService: LoggingService,
	) {
		this.log = this.loggingService.scoped("MergeHandler");
	}

	async handleDuplicate(
		analysis: DuplicateMatch,
		bodyProvider: () => Promise<string>,
		session: DuplicateHandlingSession,
		message?: string,
		opts?: { signal?: AbortSignal },
	): Promise<{
		status: "created" | "merged" | "automerged" | "skipped" | "keep-both";
		file: TFile | null;
	}> {
		throwIfAborted(opts?.signal);
		this.log.info("Handling duplicate", {
			path: analysis.file.path,
			matchType: analysis.matchType,
			canMergeSafely: analysis.canMergeSafely,
		});

		const autoMergeEnabled = this.plugin.settings.autoMergeOnAddition;
		const isUpdateOnly =
			analysis.matchType === "updated" && analysis.modifiedHighlights === 0;

		if (autoMergeEnabled && isUpdateOnly && analysis.canMergeSafely) {
			this.log.info(`Auto-merging additions into ${analysis.file.path}`);
			throwIfAborted(opts?.signal);
			const newBody = await bodyProvider();
			const res = await this._performMerge(
				analysis.file,
				newBody,
				analysis.luaMetadata,
				"merge",
			);
			if (isErr(res)) {
				return this._handleMergeFailure(res.error, "Auto-merge", 5000);
			}
			return { status: "automerged", file: res.value.file };
		}

		let promptMessage = message ?? "Duplicate detected – choose an action";
		try {
			if (analysis.matchType === "exact") {
				const highlightsFolder = this.plugin.settings.highlightsFolder || "";
				const folderPrefix = highlightsFolder.endsWith("/")
					? highlightsFolder
					: highlightsFolder + "/";
				const inHighlights = analysis.file.path.startsWith(folderPrefix);
				if (!inHighlights && highlightsFolder) {
					promptMessage =
						`An existing note for this book already exists at "${analysis.file.path}", which is outside your current Highlights folder ("${highlightsFolder}").\n\n` +
						"Choose how to proceed:\n" +
						"• Keep Both: create a new note in your Highlights folder and keep the existing note where it is.\n" +
						"• Replace: overwrite the existing note in its current location with newly imported content.\n" +
						"• Skip: take no action for this book right now.";
				}
			}
		} catch (e) {
			this.log?.warn?.("Failed to build contextual duplicate message", e);
		}

		const choice = await this.promptUser(analysis, session, promptMessage);

		switch (choice) {
			case "replace": {
				throwIfAborted(opts?.signal);
				const newBody = await bodyProvider();
				const result = await this._performMerge(
					analysis.file,
					newBody,
					analysis.luaMetadata,
					"replace",
				);
				if (isErr(result)) {
					return this._handleMergeFailure(result.error, "Replace", 7000);
				}
				return { status: "merged", file: result.value.file };
			}
			case "merge": {
				throwIfAborted(opts?.signal);
				const newBody = await bodyProvider();
				const res = await this._performMerge(
					analysis.file,
					newBody,
					analysis.luaMetadata,
					"merge",
				);
				if (isErr(res)) {
					return this._handleMergeFailure(res.error, "Merge", 7000);
				}
				return { status: "merged", file: res.value.file };
			}
			case "keep-both":
				return { status: "keep-both", file: null };
			default:
				return { status: "skipped", file: null };
		}
	}

	private async promptUser(
		analysis: DuplicateMatch,
		session: DuplicateHandlingSession,
		message: string,
	): Promise<DuplicateChoice> {
		return this.modalQueue.run("duplicate-modal", async () => {
			if (session.applyToAll && session.choice) {
				return session.choice;
			}
			const modal = this.modalFactory(this.app, analysis, message, session);
			const res = await modal.openAndGetChoice();
			const choice = res.choice ?? "skip";

			if (!session.applyToAll && res.applyToAll) {
				session.applyToAll = true;
				session.choice = choice;
			}
			return choice;
		});
	}

	private _handleMergeFailure(
		error: AppFailure,
		context: "Auto-merge" | "Merge" | "Replace",
		durationMs: number,
	): { status: "skipped"; file: null } {
		const userMessage = `${context} failed: ${formatAppFailure(error)}`;
		new Notice(userMessage, durationMs);
		this.log.error(`${context} failed`, error);
		return { status: "skipped", file: null };
	}

	// --- Inlined Merge Logic  ---

	private async _buildUpdater(
		incomingBody: string,
		luaMetadata: LuaMetadata,
		baseContent: string | null,
		mode: MergeMode,
	): Promise<Result<NoteUpdater, AppFailure>> {
		if (mode === "replace") {
			return ok((current) => ({
				// Return Ok(updater)
				frontmatter: FrontmatterService.mergeFrontmatterData(
					(current.frontmatter ?? {}) as ParsedFrontmatter,
					luaMetadata,
					this.plugin.settings.frontmatter,
				),
				body: incomingBody,
			}));
		}

		// 1. Call the new Result-based method
		const compiledResult =
			await this.templateManager.getCompiledTemplateResult();

		// 2. Handle the error case. A merge cannot proceed without a valid template.
		if (isErr(compiledResult)) {
			this.log.error(
				"Failed to get compiled template during merge operation",
				compiledResult.error,
			);
			// Propagate the failure with a specific error type
			return err({
				kind: "TemplateParseError", // Or another appropriate AppFailure kind
				message: `Merge failed: Could not load or compile the highlight template. Reason: ${compiledResult.error.kind}`,
			});
		}

		// 3. Unwrap the successful result
		const compiled = compiledResult.value;

		if (!baseContent) {
			return ok((current) => {
				// Return Ok(updater)
				const { annotations: existingAnnotations } = extractHighlightsWithStyle(
					current.body,
					this.plugin.settings.commentStyle,
				);
				const merged: Annotation[] = mergeAnnotations(
					existingAnnotations,
					luaMetadata.annotations,
				);
				const newBody = renderAnnotations(
					merged,
					compiled, // Use the unwrapped function
					this.plugin.settings.commentStyle,
					this.plugin.settings.maxHighlightGap,
				);
				const fm = FrontmatterService.mergeFrontmatterData(
					(current.frontmatter ?? {}) as ParsedFrontmatter,
					luaMetadata,
					this.plugin.settings.frontmatter,
				);
				return { frontmatter: fm, body: newBody };
			});
		}

		const base = this.fmService.parseContent(baseContent);
		return ok((current) => {
			// Return Ok(updater)
			const regions = performDiff3(current.body, base.body, incomingBody);
			const { mergedBody, hasConflict } = formatConflictRegions(regions);
			const fm = FrontmatterService.mergeFrontmatterData(
				(current.frontmatter ?? {}) as ParsedFrontmatter,
				luaMetadata,
				this.plugin.settings.frontmatter,
			);
			(fm as any)["last-merged"] = new Date().toISOString().slice(0, 10);
			if (hasConflict) (fm as any).conflicts = "unresolved";
			return { frontmatter: fm, body: mergedBody };
		});
	}

	// The calling method _performMerge must also be updated to handle the Result from _buildUpdater

	private async _performMerge(
		file: TFile,
		incomingBody: string,
		luaMetadata: LuaMetadata,
		mode: MergeMode,
	): Promise<Result<MergeSuccessResult, AppFailure>> {
		return this.mergeQueue.run(`merge:${file.path}`, async () => {
			const idResult = await this.persistence.ensureId(file);
			if (isErr(idResult)) {
				return idResult;
			}
			const uid = idResult.value;

			const baseContentResult = await this.persistence.readSnapshotById(uid);
			const baseContent = isErr(baseContentResult)
				? null
				: baseContentResult.value;

			await this.persistence.createBackup(file);

			const updaterResult = await this._buildUpdater(
				incomingBody,
				luaMetadata,
				baseContent,
				mode,
			);
			if (isErr(updaterResult)) {
				return err(updaterResult.error); // Propagate the template failure
			}
			const updater = updaterResult.value;

			const res = await this.fmService.editFile(file, updater, {
				detectConcurrentModification: true,
				skipIfNoChange: true,
				afterWrite: async (ctx) => {
					const writeResult = await this.persistence.createSnapshotFromContent(
						uid,
						ctx.newContent,
					);
					if (isErr(writeResult)) {
						this.log.warn(
							"Failed to update snapshot after merge",
							writeResult.error,
						);
					}
				},
			});

			if (isErr(res)) {
				const cause = (res.error as any)?.cause;
				const isConcurrent =
					cause === "ConcurrentModification" ||
					(res.error as any)?.message?.includes?.("Concurrent modification");

				if (isConcurrent) {
					return err({
						kind: "WriteFailed",
						path: file.path,
						cause: "ConcurrentModification",
					});
				}
				return res;
			}

			return ok({ file: res.value.file });
		});
	}
}
