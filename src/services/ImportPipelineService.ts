import path from "node:path";
import { type App, Notice, type TFile } from "obsidian";
import { bookKeyFromDocProps } from "src/lib/formatting/formatUtils";
import { runPoolWithProgress } from "src/lib/ui/progressPool";
import type KoreaderImporterPlugin from "src/main";
import {
	addSummary,
	blankSummary,
	type DuplicateHandlingSession,
	type Summary,
} from "src/types";
import type { DeviceService } from "./device/DeviceService";
import type { ImportExecutorService } from "./import/ImportExecutorService";
import type { ImportPlannerService } from "./import/ImportPlannerService";
import type {
	ExecResult,
	ImportContext,
	ImportPlan,
	WarningCode,
} from "./import/pipeline/types";
import type { LoggingService } from "./LoggingService";
import type { PromptService } from "./ui/PromptService";
import type { LocalIndexService } from "./vault/LocalIndexService";
import type { SnapshotManager } from "./vault/SnapshotManager";

export class ImportPipelineService {
	private readonly log;

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly device: DeviceService,
		private readonly localIndexService: LocalIndexService,
		private readonly snapshotManager: SnapshotManager,
		private readonly loggingService: LoggingService,
		private readonly promptService: PromptService,
		private readonly importPlanner: ImportPlannerService,
		private readonly importExecutor: ImportExecutorService,
	) {
		this.log = this.loggingService.scoped("ImportPipelineService");
	}

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

	private async resolveUserChoice(
		plan: Extract<ImportPlan, { kind: "AWAIT_USER_CHOICE" }>,
	): Promise<ImportPlan> {
		const choice = await this.promptService.confirm({
			title: "Duplicate Scan Incomplete",
			message: `The duplicate scan for "${plan.title}" did not complete, so a safe merge cannot be guaranteed. A potential match was found at: ${plan.existingPath ?? "—"}. How would you like to proceed?`,
		});
		return choice === "confirm"
			? ({ kind: "CREATE", withTimeoutWarning: true } as const)
			: ({ kind: "SKIP", reason: "USER_DECISION" } as const);
	}

	public async importHighlights(): Promise<void> {
		this.log.info("Starting KOReader highlight import process…");

		const metadataPaths = await this.device.findSdrDirectoriesWithMetadata();
		if (!metadataPaths?.length) {
			new Notice("No KOReader highlight files found (.sdr with metadata.lua).");
			this.log.info("No SDR files found to import.");
			return;
		}

		await this.localIndexService.whenReady();

		const session: DuplicateHandlingSession = {
			applyToAll: false,
			choice: null,
		};

		let summary = blankSummary();

		const runOnce = async (forceReimport: boolean) => {
			const results = await runPoolWithProgress(this.app, metadataPaths, {
				maxConcurrent: 6,
				task: async (metadataPath) => {
					const initialCtx: ImportContext = {
						metadataPath,
						sdrPath: path.dirname(metadataPath),
						forceNote: null,
						forceReimport,
						stats: null,
						latestTs: null,
						luaMetadata: null,
						warnings: [] as WarningCode[],
					};

					const { plan, ctx } = await this.importPlanner.plan(initialCtx);
					const effectivePlan =
						plan.kind === "AWAIT_USER_CHOICE"
							? await this.resolveUserChoice(plan)
							: plan;

					const exec = await this.importExecutor.execute(
						effectivePlan,
						ctx,
						session,
					);

					await this.recordOutcome(ctx, exec);

					const fileSummary = blankSummary();
					if (exec.status === "created") fileSummary.created++;
					else if (exec.status === "merged") fileSummary.merged++;
					else if (exec.status === "automerged") fileSummary.automerged++;
					else fileSummary.skipped++;

					return { fileSummary };
				},
			});

			let passSummary = blankSummary();
			for (const r of results)
				passSummary = addSummary(passSummary, r.fileSummary);
			return passSummary;
		};

		try {
			summary = await runOnce(false);

			const workDone =
				summary.created + summary.merged + summary.automerged > 0;
			const allSkipped = !workDone && summary.skipped > 0;

			if (allSkipped) {
				const choice = await this.promptService.confirm({
					title: "No New Highlights Found",
					message:
						"No changes were detected. Re-import all books anyway? This is useful if you have changed your highlight templates.",
				});

				if (choice === "confirm") {
					new Notice("Forcing re-import of all books...", 3000);
					const reSummary = await runOnce(true);
					summary = addSummary(summary, reSummary);
				}
			}

			new Notice(
				`KOReader Import finished\n${summary.created} new • ${summary.merged} merged • ${summary.automerged} auto-merged • ${summary.skipped} skipped • ${summary.errors} error(s)`,
				10_000,
			);
			this.log.info("Import process finished", summary);
		} catch (err: unknown) {
			if (
				typeof err === "object" &&
				err !== null &&
				(err as { name?: string }).name === "AbortError"
			) {
				new Notice("Import cancelled by user.");
			} else {
				this.log.error("Critical error during highlight import process:", err);
				new Notice("KOReader Importer: critical error. Check console.");
			}
		} finally {
			this.log.info("Flushing database index …");
			await this.localIndexService.flushIndex();
			try {
				await this.snapshotManager.cleanupOldBackups(
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
		const session: DuplicateHandlingSession = {
			applyToAll: false,
			choice: null,
		};

		const initialCtx: ImportContext = {
			metadataPath: params.metadataPath,
			sdrPath: path.dirname(params.metadataPath),
			forceNote: params.existingNoteOverride ?? null,
			forceReimport: false,
			stats: null,
			latestTs: null,
			luaMetadata: null,
			warnings: [],
		};

		const { plan, ctx } = await this.importPlanner.plan(initialCtx);
		const effectivePlan =
			plan.kind === "AWAIT_USER_CHOICE"
				? await this.resolveUserChoice(plan)
				: plan;

		const execResult = await this.importExecutor.execute(
			effectivePlan,
			ctx,
			session,
		);

		await this.recordOutcome(ctx, execResult);

		const fileSummary = blankSummary();
		if (execResult.status === "created") fileSummary.created++;
		else if (execResult.status === "merged") fileSummary.merged++;
		else if (execResult.status === "automerged") fileSummary.automerged++;
		else fileSummary.skipped++;

		const changed =
			fileSummary.created + fileSummary.merged + fileSummary.automerged > 0;
		return { changed, fileSummary };
	}
}
