import { type App, Notice, type TFile } from "obsidian";
import { KeyedQueue, throwIfAborted } from "src/lib/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type { AppFailure } from "src/lib/errors/types";
import {
	buildPromptMessage,
	createMergeContext,
	determineMergeStrategy,
} from "src/lib/merge/mergeCore";
import * as noteCore from "src/lib/noteCore";
import type KoreaderImporterPlugin from "src/main";
import type { LoggingService } from "src/services/LoggingService";
import type {
	DuplicateChoice,
	DuplicateHandlingSession,
	DuplicateMatch,
	IDuplicateHandlingModal,
	LuaMetadata,
} from "src/types";
import type { TemplateManager } from "../parsing/TemplateManager";
import type { NotePersistenceService } from "./NotePersistenceService";

type MergeMode = "replace" | "merge";

// Define a clear result type for the successful result of handleDuplicate.
type MergeActionResult = {
	status: "created" | "merged" | "automerged" | "skipped" | "keep-both";
	file: TFile | null;
};

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
	): Promise<Result<MergeActionResult, AppFailure>> {
		throwIfAborted(opts?.signal);

		// Pure strategy determination
		const context = createMergeContext(analysis, {
			autoMergeOnAddition: this.plugin.settings.autoMergeOnAddition,
		});
		const strategy = determineMergeStrategy(context);

		// Shell handles execution based on pure strategy
		switch (strategy) {
			case "auto-merge":
				return this.executeAutoMerge(analysis, bodyProvider);
			case "prompt-user":
				return this.executeWithUserPrompt(
					analysis,
					bodyProvider,
					session,
					message,
				);
			// ... other cases for future extensibility
			default:
				return this.executeWithUserPrompt(
					analysis,
					bodyProvider,
					session,
					message,
				);
		}
	}

	private async executeAutoMerge(
		analysis: DuplicateMatch,
		bodyProvider: () => Promise<string>,
		opts?: { signal?: AbortSignal },
	): Promise<Result<MergeActionResult, AppFailure>> {
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
			this.log.error(`Auto-merge failed for ${analysis.file.path}`, res.error);
			return err(res.error);
		}
		return ok({ status: "automerged", file: res.value.file });
	}

	private async executeWithUserPrompt(
		analysis: DuplicateMatch,
		bodyProvider: () => Promise<string>,
		session: DuplicateHandlingSession,
		message?: string,
		opts?: { signal?: AbortSignal },
	): Promise<Result<MergeActionResult, AppFailure>> {
		const promptResult = buildPromptMessage(
			analysis,
			this.plugin.settings.highlightsFolder,
		);
		const promptMessage = promptResult.ok
			? promptResult.value
			: message || "Duplicate detected – choose an action";

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
					this.log.error(
						`Replace failed for ${analysis.file.path}`,
						result.error,
					);
					return err(result.error);
				}
				return ok({ status: "merged", file: result.value.file });
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
					this.log.error(`Merge failed for ${analysis.file.path}`, res.error);
					return err(res.error);
				}
				return ok({ status: "merged", file: res.value.file });
			}
			case "keep-both":
				return ok({ status: "keep-both", file: null });
			default:
				return ok({ status: "skipped", file: null });
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

	// --- Inlined Merge Logic  ---
	private async _performMerge(
		file: TFile,
		incomingBody: string,
		luaMetadata: LuaMetadata,
		mode: MergeMode,
		opts?: { signal?: AbortSignal },
	): Promise<Result<MergeSuccessResult, AppFailure>> {
		return this.mergeQueue.run(`merge:${file.path}`, async () => {
			// 1. [SHELL] Gather all necessary state from I/O
			const idResult = await this.persistence.ensureId(file);
			if (isErr(idResult)) {
				return err({
					kind: "WriteFailed",
					path: file.path,
					cause: idResult.error,
				});
			}
			const uid = idResult.value;

			const baseContentResult = await this.persistence.readSnapshotById(uid);
			const baseContent = isErr(baseContentResult)
				? null
				: baseContentResult.value;

			const compiledResult =
				await this.templateManager.getCompiledTemplateResult();
			if (isErr(compiledResult)) return err(compiledResult.error);

			// 2. [CORE] Call the pure preparer function with all gathered state
			let prepResult: noteCore.MergePreparation;
			if (mode === "replace") {
				prepResult = noteCore.prepareForReplace(
					luaMetadata,
					incomingBody,
					this.plugin.settings.frontmatter,
				);
			} else {
				const mergePrepResult = noteCore.prepareForMerge({
					baseSnapshotBody: baseContent,
					incomingBody,
					lua: luaMetadata,
					settings: this.plugin.settings,
					compiledTemplate: compiledResult.value,
				});
				if (isErr(mergePrepResult)) {
					return err({
						kind: "ReadFailed",
						path: file.path,
						cause: mergePrepResult.error,
					});
				}
				prepResult = mergePrepResult.value;
			}

			// Handle diagnostics if snapshot was missing
			if (!prepResult.snapshotUsed && prepResult.kind === "conflicted") {
				this.log.info(
					`Merge for ${file.path} used fallback strategy: ${prepResult.diagnostics.reason}`,
				);
				// Show user notice if there's a user message
				if (prepResult.diagnostics.userMessage) {
					new Notice(prepResult.diagnostics.userMessage);
				}
			}

			// 3. [SHELL] Commit the result using the atomic persistence service
			const atomicRes = await this.persistence.updateNoteAtomically({
				file,
				updater: prepResult.updater,
				uid,
				signal: opts?.signal,
			});

			if (isErr(atomicRes)) return atomicRes;

			// Determine if conflicts were present based on the preparation result
			const conflictsExist = prepResult.kind === "conflicted";

			return ok({ file: atomicRes.value.file, hasConflicts: conflictsExist });
		});
	}
}
