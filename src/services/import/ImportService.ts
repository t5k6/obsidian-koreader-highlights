import path from "node:path";
import { type App, Notice, type TFile } from "obsidian";
import { runPool } from "src/lib/concurrency";
import { isAbortError, throwIfAborted } from "src/lib/concurrency/cancellation";
import { bookKeyFromDocProps } from "src/lib/formatting/formatUtils";
import { parse as parseMetadata } from "src/lib/parsing/luaParser";
import type KoreaderImporterPlugin from "src/main";
import type { DeviceService } from "src/services/device/DeviceService";
import { executeImportPlan, planImport } from "src/services/import/logic";
import type {
	ExecResult,
	ExecutorIO,
	ImportContext,
	ImportPlan,
	PlannerIO,
} from "src/services/import/types";
import type { PromptService } from "src/services/ui/PromptService";
import type { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import {
	blankSummary,
	type DuplicateHandlingSession,
	type StaleLocationSession,
	type Summary,
} from "src/types";
import { StaleLocationModal } from "src/ui/StaleLocationModal";
import { withProgress } from "src/ui/utils/progress";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { FrontmatterService } from "../parsing/FrontmatterService";
import type { TemplateManager } from "../parsing/TemplateManager";
import type { DuplicateFinder } from "../vault/DuplicateFinder";
import type { MergeHandler } from "../vault/MergeHandler";
import type { NotePersistenceService } from "../vault/NotePersistenceService";

export class ImportService {
	private readonly log;

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly device: DeviceService,
		private readonly localIndexService: IndexCoordinator,
		private readonly persistence: NotePersistenceService,
		private readonly loggingService: LoggingService,
		private readonly promptService: PromptService,
		// Dependencies inherited from ImportService
		private readonly fs: FileSystemService,
		private readonly dupFinder: DuplicateFinder,
		private readonly fmService: FrontmatterService,
		private readonly templateManager: TemplateManager,
		private readonly mergeHandler: MergeHandler,
	) {
		this.log = this.loggingService.scoped("ImportService");
	}

	// --- Core Logic ---

	private buildPlannerIO(): PlannerIO {
		return {
			fs: this.fs,
			index: this.localIndexService,
			parser: (lua: string) => parseMetadata(lua),
			device: this.device,
			dupFinder: this.dupFinder,
			log: this.loggingService,
			settings: this.plugin.settings,
			app: this.app,
		};
	}

	private buildExecutorIO(): ExecutorIO {
		return {
			app: this.app,
			fs: this.fs,
			fmService: this.fmService,
			templateManager: this.templateManager,
			mergeHandler: this.mergeHandler,
			persistence: this.persistence,
			settings: this.plugin.settings,
			log: this.loggingService,
		};
	}
	public plan(
		initial: ImportContext,
		opts?: { signal?: AbortSignal },
	): Promise<{
		plan: ImportPlan;
		ctx: ImportContext;
		diagnostics: import("../../lib/parsing/luaParser").Diagnostic[];
	}> {
		return planImport(initial, this.buildPlannerIO(), opts);
	}

	public execute(
		plan: ImportPlan,
		ctx: ImportContext,
		session: DuplicateHandlingSession,
		opts?: { signal?: AbortSignal },
	): Promise<ExecResult> {
		return executeImportPlan(plan, ctx, session, this.buildExecutorIO(), opts);
	}

	// --- Orchestration Logic ---

	private async recordOutcome(ctx: ImportContext, exec: ExecResult) {
		try {
			await this.localIndexService.recordImportSuccess({
				path: ctx.metadataPath,
				mtime: ctx.stats?.mtimeMs ?? 0,
				size: ctx.stats?.size ?? 0,
				newestAnnotationTs: ctx.latestTs,
				bookKey: ctx.luaMetadata
					? bookKeyFromDocProps(ctx.luaMetadata.docProps)
					: null,
				md5: ctx.luaMetadata?.md5 ?? null,
				vaultPath: exec.file?.path ?? null,
			});
		} catch (e) {
			this.log.warn("Failed to record import success", e);
		}
	}

	public async importHighlights(): Promise<void> {
		this.log.info("Starting KOReader highlight import process…");

		const metadataPaths = await withProgress(
			this.app,
			0,
			(tick, signal) => this.device.findSdrDirectoriesWithMetadata({ signal }),
			{ title: "Scanning KOReader device…", showWhenTotalIsZero: true },
		);

		if (!metadataPaths?.length) {
			new Notice("No KOReader highlight files found (.sdr with metadata.lua).");
			return;
		}

		await this.localIndexService.whenReady();

		const sessions = {
			duplicates: { applyToAll: false, choice: null },
			staleLocations: { applyToAll: false, choice: null },
		};

		const summary = blankSummary();
		let timedOut = false; // Flag for partial scan timeout

		try {
			await withProgress(
				this.app,
				metadataPaths.length,
				async (tick, signal) => {
					const results = await runPool(
						metadataPaths,
						6,
						async (metadataPath) => {
							const initialCtx: ImportContext = {
								metadataPath,
								sdrPath: path.dirname(metadataPath),
								forceNote: null,
								forceReimport: false, // For simplicity, re-import logic is handled outside this loop
								stats: null,
								latestTs: null,
								luaMetadata: null,
								warnings: [],
							};

							const execResult = await this._runPipelineForItem(
								initialCtx,
								sessions,
								signal,
							);

							// Check for partial scan timeout warning
							if (initialCtx.warnings.includes("duplicate-timeout")) {
								timedOut = true;
							}

							return execResult;
						},
						signal,
					);

					// Tally summary after the pool completes
					for (const res of results) {
						if (res.status === "created") summary.created++;
						else if (res.status === "merged") summary.merged++;
						else if (res.status === "automerged") summary.automerged++;
						else summary.skipped++;
					}
				},
			);

			// Post-import summary notice logic remains here...
			if (timedOut) {
				new Notice(
					"Note: Duplicate scan timed out for some items. Slower, partial matching was used.",
					8000,
				);
			}

			new Notice(
				`KOReader Import finished\n${summary.created} new • ${summary.merged} merged • ${summary.automerged} auto-merged • ${summary.skipped} skipped`,
				10_000,
			);
			this.log.info("Import process finished", summary);
		} catch (err: unknown) {
			if (isAbortError(err)) {
				new Notice("Import cancelled by user.");
			} else {
				this.log.error("Critical error during highlight import process:", err);
				new Notice("KOReader Importer: critical error. Check console.");
			}
		} finally {
			this.log.info("Flushing database index …");
			await this.localIndexService.flushIndex();
			try {
				await this.persistence.cleanupOldBackups(
					this.plugin.settings.backupRetentionDays,
				);
			} catch (cleanupError) {
				this.log.error(
					"An error occurred during backup cleanup.",
					cleanupError,
				);
			}
		}
	}

	public async runSingleFilePipeline(params: {
		metadataPath: string;
		existingNoteOverride?: TFile;
	}): Promise<{ changed: boolean; fileSummary: Summary }> {
		const sessions = {
			duplicates: { applyToAll: false, choice: null },
			staleLocations: { applyToAll: false, choice: null },
		};

		const initialCtx: ImportContext = {
			metadataPath: params.metadataPath,
			sdrPath: path.dirname(params.metadataPath),
			forceNote: params.existingNoteOverride ?? null,
			forceReimport: true, // A single-file run implies we want to process it
			stats: null,
			latestTs: null,
			luaMetadata: null,
			warnings: [],
		};

		const execResult = await this._runPipelineForItem(initialCtx, sessions);

		const fileSummary = blankSummary();
		if (execResult.status === "created") fileSummary.created++;
		else if (execResult.status === "merged") fileSummary.merged++;
		else if (execResult.status === "automerged") fileSummary.automerged++;
		else fileSummary.skipped++;

		const changed =
			fileSummary.created + fileSummary.merged + fileSummary.automerged > 0;
		return { changed, fileSummary };
	}

	private async _runPipelineForItem(
		initialCtx: ImportContext,
		sessions: {
			duplicates: DuplicateHandlingSession;
			staleLocations: StaleLocationSession;
		},
		signal?: AbortSignal,
	): Promise<ExecResult> {
		try {
			throwIfAborted(signal);

			// 1. Plan Phase
			const { plan, ctx, diagnostics } = await this.plan(initialCtx, {
				signal,
			});

			// Log all diagnostics from the planning phase
			diagnostics.forEach((d) => {
				if (d.severity === "error") this.log.error(d.message);
				else if (d.severity === "warn") this.log.warn(d.message);
				else this.log.info(d.message);
			});

			throwIfAborted(signal);

			// 2. Resolve Gates (User Interaction)
			let effectivePlan = plan;

			if (effectivePlan.kind === "AWAIT_STALE_LOCATION_CONFIRM") {
				const staleSession = sessions.staleLocations;
				let choice = staleSession.applyToAll ? staleSession.choice : null;

				if (!choice) {
					const modal = new StaleLocationModal(
						this.app,
						"Existing Note Found in Different Folder",
						`A note for "${effectivePlan.match.luaMetadata.docProps.title}" exists at "${effectivePlan.match.file.path}", outside your current highlights folder. Merge into the existing note?`,
						staleSession,
					);
					const res = await modal.openAndAwaitResult();
					choice = res?.choice ?? "skip-stale";
				}

				effectivePlan =
					choice === "merge-stale"
						? { kind: "MERGE", match: effectivePlan.match }
						: { kind: "SKIP", reason: "USER_DECISION" };
			}

			if (effectivePlan.kind === "AWAIT_USER_CHOICE") {
				const userConfirmed = await this.promptService.confirm({
					title: "Duplicate Scan Incomplete",
					message: `The duplicate scan for "${effectivePlan.title}" did not complete. A potential match was found at: ${effectivePlan.existingPath ?? "—"}. Create a new note anyway?`,
				});
				effectivePlan =
					userConfirmed === "confirm"
						? { kind: "CREATE", withTimeoutWarning: true }
						: { kind: "SKIP", reason: "USER_DECISION" };
			}

			throwIfAborted(signal);

			// 3. Execute Phase
			const execResult = await this.execute(
				effectivePlan,
				ctx,
				sessions.duplicates,
				{ signal },
			);

			// 4. Record Outcome Phase
			await this.recordOutcome(ctx, execResult);

			return execResult;
		} catch (err) {
			if (isAbortError(err)) {
				this.log.info(`Import for ${initialCtx.metadataPath} cancelled.`);
				// A cancelled operation is effectively skipped from a summary perspective.
				return { status: "skipped", file: null };
			}

			this.log.error(
				`Critical failure in import pipeline for ${initialCtx.metadataPath}`,
				err,
			);
			// Log failure to the index to prevent retrying a poison pill message
			await this.localIndexService.recordImportFailure(
				initialCtx.metadataPath,
				err,
			);
			return { status: "skipped", file: null }; // Treat hard failures as skips to not halt a batch
		}
	}
}
