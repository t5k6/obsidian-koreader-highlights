import { type App, Notice, type TFile } from "obsidian";
import { getOptimalConcurrency, runPool } from "src/lib/concurrency";
import { isAbortError, throwIfAborted } from "src/lib/concurrency/cancellation";
import { KeyedQueue } from "src/lib/concurrency/concurrency";
import { isErr } from "src/lib/core/result";
import { formatAppFailure } from "src/lib/errors/types";
import { bookKeyFromDocProps } from "src/lib/formatting/formatUtils";
import { parse as parseMetadata } from "src/lib/parsing/luaParser";
import { Pathing } from "src/lib/pathing";
import type KoreaderImporterPlugin from "src/main";
import type { DeviceService } from "src/services/device/DeviceService";
import { executeImportPlan } from "src/services/import/importExecutor";
import type { EnrichedImportContext } from "src/services/import/importPlanner";
import {
	enrichWithStatistics,
	parseLuaMetadata,
	planImport,
} from "src/services/import/importPlanner";
import type {
	ExecResult,
	ExecutorIO,
	ImportContext,
	ImportPlan,
	PlannerIO,
} from "src/services/import/types";
import type { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import {
	type DuplicateHandlingSession,
	type LuaMetadata,
	type StaleLocationSession,
	Summary,
} from "src/types";
import { InteractionModal } from "src/ui/InteractionModal";
import { withProgress } from "src/ui/utils/progress";
import { confirmStaleLocation } from "src/ui/utils/promptUtils";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { NoteEditorService } from "../parsing/NoteEditorService";
import type { TemplateManager } from "../parsing/TemplateManager";
import type { DuplicateFinder } from "../vault/DuplicateFinder";
import type { MergeHandler } from "../vault/MergeHandler";
import type { NotePersistenceService } from "../vault/NotePersistenceService";

export class ImportService {
	private readonly log;
	private readonly bookPipelineQueue = new KeyedQueue();

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly device: DeviceService,
		private readonly localIndexService: IndexCoordinator,
		private readonly persistence: NotePersistenceService,
		private readonly loggingService: LoggingService,
		private readonly fs: FileSystemService,
		private readonly dupFinder: DuplicateFinder,
		private readonly noteEditorService: NoteEditorService,
		private readonly templateManager: TemplateManager,
		private readonly mergeHandler: MergeHandler,
	) {
		this.log = this.loggingService.scoped("ImportService");
	}

	private async _cleanupStaleIndexEntries(
		paths: string[],
		signal?: AbortSignal,
	): Promise<void> {
		if (paths.length === 0) return;

		this.log.info(`Cleaning ${paths.length} stale index entries...`);

		const cleanupStream = runPool(
			paths,
			async (p: string) => {
				try {
					throwIfAborted(signal);
					await this.localIndexService.deleteBookInstanceByPath(p);
				} catch (e) {
					if (!isAbortError(e)) {
						this.log.warn(
							`Failed to clean stale index entry for path: ${p}`,
							e,
						);
					}
				}
			},
			{ concurrency: 4, signal },
		);

		for await (const result of cleanupStream) {
			if (!result.ok && !isAbortError(result.error)) {
				this.log.error(
					"Unexpected error during index cleanup stream",
					result.error,
				);
			}
		}
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
			templateManager: this.templateManager,
			mergeHandler: this.mergeHandler,
			persistence: this.persistence,
			settings: this.plugin.settings,
			log: this.loggingService,
		};
	}
	public plan(
		initial: ImportContext & {
			luaMetadata: LuaMetadata;
			latestTs: string | null;
		},
		degradedScanCache: Map<string, TFile[]> | null,
		opts?: { signal?: AbortSignal },
	): Promise<{
		plan: ImportPlan;
		ctx: ImportContext;
		diagnostics: import("../../lib/parsing/luaParser").Diagnostic[];
	}> {
		return planImport(initial, this.buildPlannerIO(), degradedScanCache, opts);
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
				title: ctx.luaMetadata?.docProps.title ?? undefined,
				authors: ctx.luaMetadata?.docProps.authors ?? undefined,
			});
		} catch (e) {
			this.log.warn("Failed to record import success", e);
		}
	}

	public async importHighlights(options?: {
		forceReimportAll?: boolean;
		signal?: AbortSignal;
	}): Promise<void> {
		this.log.info("Starting KOReader highlight import process…");

		if (this.localIndexService.isRebuildingIndex?.()) {
			this.log.warn("Index is rebuilding; duplicate checks may be slower.");
			new Notice(
				"KOReader: index is rebuilding — duplicate checks may be slower.",
				6000,
			);
		}

		const metadataPaths = await withProgress(
			this.app,
			0,
			(tick, signal) => this.device.findSdrDirectoriesWithMetadata({ signal }),
			{
				title: "Scanning KOReader device…",
				showWhenTotalIsZero: true,
				signal: options?.signal,
			},
		);

		if (!metadataPaths?.length) {
			new Notice("No KOReader highlight files found (.sdr with metadata.lua).");
			return;
		}

		await this.localIndexService.whenReady();

		let degradedScanCache: Map<string, TFile[]> | null = null;
		if (
			this.localIndexService.isRebuildingIndex() ||
			!this.localIndexService.isIndexPersistent()
		) {
			this.log.info(
				"Index is in degraded mode. Building a pre-scan cache for duplicates.",
			);
			degradedScanCache = await this.dupFinder.buildDegradedScanCache();
		}

		const sessions = {
			duplicates: { applyToAll: false, choice: null },
			staleLocations: { applyToAll: false, choice: null },
		};

		let summary = Summary.empty();
		const timedOutTitles: string[] = [];

		try {
			await withProgress(
				this.app,
				metadataPaths.length,
				async (tick, signal) => {
					const concurrency = getOptimalConcurrency();

					const resultsStream = runPool(
						metadataPaths,
						// Worker function with explicit type annotation
						async (metadataPath: string) => {
							const initialCtx: ImportContext = {
								metadataPath,
								sdrPath: Pathing.systemDirname(metadataPath),
								forceNote: null,
								forceReimport: !!options?.forceReimportAll,
								stats: null,
								latestTs: null,
								luaMetadata: null,
								warnings: [],
							};

							const execResult = await this._runPipelineForItem(
								initialCtx,
								sessions,
								degradedScanCache, // Pass the pre-scanned results
								signal,
							);

							// Track titles instead of a boolean flag
							if (
								initialCtx.warnings.includes("duplicate-timeout") &&
								initialCtx.luaMetadata?.docProps.title
							) {
								timedOutTitles.push(initialCtx.luaMetadata.docProps.title);
							}

							return execResult;
						},
						{ concurrency, signal },
					);

					for await (const result of resultsStream) {
						if (result.ok) {
							summary = Summary.addResult(summary, result.value);
						} else {
							this.log.error(
								`Pipeline item failed for ${result.error.item}`,
								result.error.error,
							);
							summary = Summary.add(summary, { skipped: 1, errors: 1 });
						}
						tick(); // Advance progress bar for each completed item
					}
				},
				{ signal: options?.signal },
			);

			let summaryMessage = `KOReader Import finished\n${summary.created} new • ${summary.merged} merged • ${summary.automerged} auto-merged • ${summary.skipped} skipped`;

			if (timedOutTitles.length > 0) {
				const listForNotice =
					timedOutTitles.length > 3
						? `${timedOutTitles.slice(0, 3).join(", ")}...`
						: timedOutTitles.join(", ");

				summaryMessage += `\n\nNote: Scan was slow for some books (e.g., ${listForNotice}). A partial match was used.`;
				this.log.warn(
					"Full list of books with slow duplicate scans:",
					timedOutTitles,
				);
			}

			new Notice(summaryMessage, 10_000);
			this.log.info("Import process finished", {
				...summary,
				timedOutCount: timedOutTitles.length,
			});
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
			sdrPath: Pathing.systemDirname(params.metadataPath),
			forceNote: params.existingNoteOverride ?? null,
			forceReimport: true, // A single-file run implies we want to process it
			stats: null,
			latestTs: null,
			luaMetadata: null,
			warnings: [],
		};

		const execResult = await this._runPipelineForItem(
			initialCtx,
			sessions,
			null,
		);

		const fileSummary = Summary.addResult(Summary.empty(), execResult);

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
		degradedScanCache: Map<string, TFile[]> | null,
		signal?: AbortSignal,
	): Promise<ExecResult> {
		throwIfAborted(signal);

		// 1. Read content (I/O)
		const luaContent = await this.device.readMetadataFileContent(
			initialCtx.sdrPath,
		);
		if (!luaContent) return { status: "skipped", file: null, warnings: [] };

		// 2. Parse metadata (pure function)
		const parseResult = parseLuaMetadata(luaContent, initialCtx.sdrPath);
		if (isErr(parseResult)) {
			this.log.warn(
				`Parsing failed for ${initialCtx.metadataPath}: ${formatAppFailure(parseResult.error)}`,
			);
			return { status: "skipped", file: null, warnings: [] };
		}

		const { meta, diagnostics: parseDiagnostics } = parseResult.value;

		// 3. Get book statistics (I/O)
		const stats = await this.device.findBookStatistics(
			meta.docProps.title,
			meta.docProps.authors,
			meta.md5,
			signal,
		);

		// 4. Enrich with statistics (pure function)
		const enrichedMeta = enrichWithStatistics(meta, stats);

		// 5. Construct enriched context
		const enrichedCtx: EnrichedImportContext = {
			...initialCtx,
			luaMetadata: enrichedMeta,
			latestTs:
				meta.annotations?.reduce<string | null>(
					(acc: string | null, a: { datetime: string }) =>
						!acc || a.datetime > acc ? a.datetime : acc,
					null,
				) ?? null,
		};

		const bookKey = bookKeyFromDocProps(enrichedMeta.docProps);

		// Log diagnostics
		parseDiagnostics.forEach(
			(d: import("src/lib/parsing/luaParser").Diagnostic) => {
				if (d.severity === "error") this.log.error(d.message);
				else if (d.severity === "warn") this.log.warn(d.message);
				else this.log.info(d.message);
			},
		);

		// 3. Queue the rest of the pipeline
		return this.bookPipelineQueue.run(bookKey, async () => {
			try {
				throwIfAborted(signal);

				const { plan, ctx, diagnostics } = await this.plan(
					enrichedCtx,
					degradedScanCache, // Pass it down to the planner
					{ signal },
				);

				// Log all diagnostics from the planning phase
				diagnostics.forEach((d) => {
					if (d.severity === "error") this.log.error(d.message);
					else if (d.severity === "warn") this.log.warn(d.message);
					else this.log.info(d.message);
				});

				// --- Perform index cleanup as a shell side-effect ---
				if (ctx.indexCleanupPaths?.length) {
					await this._cleanupStaleIndexEntries(ctx.indexCleanupPaths, signal);
				}

				throwIfAborted(signal);

				let effectivePlan = plan;

				if (effectivePlan.kind === "AWAIT_STALE_LOCATION_CONFIRM") {
					const choice = await confirmStaleLocation(
						this.app,
						{
							title: "Existing Note Found in Different Folder",
							message: `A note for "${effectivePlan.match.luaMetadata.docProps.title}" exists at "${effectivePlan.match.file.path}", outside your current highlights folder. Merge into the existing note?`,
							session: sessions.staleLocations,
						},
						signal,
					);

					if (choice === "merge-stale") {
						effectivePlan = { kind: "MERGE", match: effectivePlan.match };
					} else if (choice === "create-new") {
						// User wants a new note in the correct folder
						effectivePlan = { kind: "CREATE" };
					} else {
						// 'skip-stale' or closed modal
						effectivePlan = { kind: "SKIP", reason: "USER_DECISION" };
					}
				}

				if (effectivePlan.kind === "AWAIT_USER_CHOICE") {
					const userConfirmed = await InteractionModal.confirm(this.app, {
						title: "Duplicate Scan Incomplete",
						message: `The duplicate scan for "${effectivePlan.title}" did not complete. A potential match was found at: ${effectivePlan.existingPath ?? "—"}. Create a new note anyway?`,
						ctaText: "Proceed",
					});

					effectivePlan = userConfirmed
						? { kind: "CREATE", withTimeoutWarning: true }
						: { kind: "SKIP", reason: "USER_DECISION" };
				}

				throwIfAborted(signal);

				const execResult = await this.execute(
					effectivePlan,
					ctx,
					sessions.duplicates,
					{ signal },
				);

				if (
					execResult.status === "created" ||
					execResult.status === "merged" ||
					execResult.status === "automerged"
				) {
					await this.recordOutcome(ctx, execResult);
				} else if (ctx.stats) {
					await this.localIndexService.recordImportFailure(
						ctx.metadataPath,
						"Skipped or failed during execution",
					);
				}

				return execResult;
			} catch (err) {
				if (isAbortError(err)) {
					this.log.info(`Import for ${initialCtx.metadataPath} cancelled.`);
					return { status: "skipped", file: null, warnings: [] };
				}

				this.log.error(
					`Critical failure in import pipeline for ${initialCtx.metadataPath}`,
					err,
				);
				await this.localIndexService.recordImportFailure(
					initialCtx.metadataPath,
					err,
				);

				return { status: "skipped", file: null, warnings: [] };
			}
		});
	}
}
