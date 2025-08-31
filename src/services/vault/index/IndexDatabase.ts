import type { App } from "obsidian";
import type { Database } from "sql.js";
import { isAbortError } from "src/lib/concurrency";
import { ConcurrentDatabase } from "src/lib/concurrency/ConcurrentDatabase";
import { isErr } from "src/lib/core/result";
import { isTFolder } from "src/lib/obsidian/typeguards";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { NoteEditorService } from "src/services/parsing/NoteEditorService";
import type { SqlJsManager } from "src/services/SqlJsManager";
import { ParallelIndexProcessor } from "../ParallelIndexProcessor";
import { CURRENT_DB_VERSION, DDL, migrateDb } from "./schema";

export type IndexState = "persistent" | "in_memory" | "unavailable";

export type RebuildPhase =
	| "idle"
	| "rebuilding"
	| "complete"
	| "failed"
	| "cancelled";
export type RebuildStatus = {
	phase: RebuildPhase;
	progress?: { current: number; total: number };
	error?: unknown;
};

type RebuildOptions = {
	app: App;
	noteEditorService: NoteEditorService;
	highlightsFolder: string;
	writer: (batch: import("src/types").BookMetadata[]) => Promise<void>;
	workers?: number;
	batchSize?: number;
};

export class IndexDatabase {
	private readonly log;
	private idxDb: Database | null = null;
	private concurrent: ConcurrentDatabase | null = null;
	private state: IndexState = "unavailable";
	private readyResolve!: () => void;
	private readonly readyP: Promise<void>;
	private initializing: Promise<void> | null = null;
	private readonly dbPath: string;
	private rebuildStatus: RebuildStatus = { phase: "idle" };
	private rebuildAbortController: AbortController | null = null;
	private rebuildP: Promise<void> | null = null;
	private rebuildListeners = new Set<(s: RebuildStatus) => void>();

	constructor(
		private readonly sql: SqlJsManager,
		private readonly fs: FileSystemService,
		private readonly logging: LoggingService,
	) {
		this.log = logging.scoped("IndexDatabase");
		this.dbPath = this.fs.joinPluginDataPath("index.db");
		this.readyP = new Promise<void>((r) => {
			this.readyResolve = r;
		});
	}

	public getState(): IndexState {
		return this.state;
	}

	public isReady(): boolean {
		return !!this.idxDb;
	}

	public async whenReady(): Promise<void> {
		await this.ensureReady();
		return this.readyP;
	}

	public getConcurrent(): ConcurrentDatabase {
		if (!this.concurrent) throw new Error("IndexDatabase not ready");
		return this.concurrent;
	}

	public onRebuildStatus(
		listener: (status: RebuildStatus) => void,
	): () => void {
		this.rebuildListeners.add(listener);
		listener(this.rebuildStatus); // push current status immediately
		return () => this.rebuildListeners.delete(listener);
	}

	public getRebuildStatus(): RebuildStatus {
		return this.rebuildStatus;
	}

	public isRebuilding(): boolean {
		return this.rebuildStatus.phase === "rebuilding";
	}

	public async whenRebuildComplete(): Promise<void> {
		if (this.state !== "in_memory") return;
		await this.rebuildP?.catch(() => {});
	}

	public async startBackgroundRebuild(opts: RebuildOptions): Promise<void> {
		if (this.state !== "in_memory" || this.isRebuilding()) {
			return;
		}

		this.rebuildAbortController = new AbortController();
		const signal = this.rebuildAbortController.signal;

		this.setRebuildStatus({
			phase: "rebuilding",
			progress: { current: 0, total: 0 },
		});

		this.rebuildP = (async () => {
			try {
				await new Promise((resolve) => setTimeout(resolve, 0));

				const root = opts.app.vault.getAbstractFileByPath(
					opts.highlightsFolder ?? "",
				);
				if (!isTFolder(root)) {
					const error = new Error(`Missing folder: ${opts.highlightsFolder}`);
					this.setRebuildStatus({ phase: "failed", error });
					this.log.error("Index rebuild failed", error);
					return; // Exit gracefully
				}

				const { getOptimalConcurrency } = await import("src/lib/concurrency");
				const workers = opts.workers ?? getOptimalConcurrency();
				const batchSize = opts.batchSize ?? 64;

				const filesStream = this.fs.iterateMarkdownFiles(root, {
					recursive: true,
					signal,
				});

				const processor = new ParallelIndexProcessor(
					opts.noteEditorService,
					opts.writer,
					this.log,
					{ workers, batchSize },
				);

				const onProgress = (current: number) => {
					this.setRebuildStatus({
						phase: "rebuilding",
						progress: { current, total: 0 },
					});
				};

				const result = await processor.processFiles(
					filesStream,
					onProgress,
					signal,
				);

				if (signal.aborted) {
					this.setRebuildStatus({ phase: "cancelled" });
					return;
				}

				if (isErr(result)) {
					this.log.error("Index rebuild failed", result.error);
					throw result.error;
				}

				const processResult = result.value;
				if (processResult.errors.length > 0) {
					this.log.warn(
						`Index rebuild completed with ${processResult.errors.length} errors.`,
					);
				}

				this.setRebuildStatus({ phase: "complete" });
				this.log.info("In-memory index rebuild completed.");
			} catch (e) {
				if (isAbortError(e)) {
					this.setRebuildStatus({ phase: "cancelled" });
					this.log.warn("Index rebuild cancelled.");
				} else {
					this.setRebuildStatus({ phase: "failed", error: e });
					this.log.error("Index rebuild failed", e);
				}
			} finally {
				this.rebuildAbortController = null;
			}
		})();
	}

	public cancelRebuild(): void {
		this.rebuildAbortController?.abort();
	}

	private setRebuildStatus(status: RebuildStatus): void {
		this.rebuildStatus = status;
		for (const l of this.rebuildListeners) {
			try {
				l(status);
			} catch (e) {
				this.log.warn("Rebuild listener threw", e);
			}
		}
	}

	public async whenFullyReady(): Promise<void> {
		await this.whenReady();
		if (this.getState() === "in_memory") {
			await this.whenRebuildComplete();
		}
	}

	public async flush(): Promise<void> {
		if (this.state === "persistent") {
			await this.sql.persistDatabase(this.dbPath).catch((e) => {
				this.log.warn("Persisting index failed", e);
			});
		}
	}

	public async dispose(): Promise<void> {
		await this.flush();
		this.sql.closeDatabase(this.dbPath);
	}

	private async ensureReady(): Promise<void> {
		if (this.idxDb || this.initializing)
			return this.initializing ?? Promise.resolve();

		this.initializing = (async () => {
			try {
				const dbRes = await this.sql.openDatabase(this.dbPath, {
					schemaSql: DDL,
					validate: true,
				});
				if (isErr(dbRes)) throw dbRes.error;
				this.idxDb = dbRes.value;
				migrateDb(this.idxDb, this.log);
				this.state = "persistent";
				this.concurrent = new ConcurrentDatabase(
					async () => this.idxDb!,
					(dirty) => this.sql.setDirty(this.dbPath, dirty),
				);
				this.readyResolve();
				return;
			} catch (e) {
				this.log.warn(
					"IndexDatabase persistent open failed; falling back to in-memory",
					e,
				);
			}

			try {
				const mem = await this.sql.createInMemoryDatabase();
				this.idxDb = mem;
				this.sql.applySchema(mem, DDL);
				mem.run(`PRAGMA user_version = ${CURRENT_DB_VERSION};`);
				migrateDb(mem, this.log);
				this.state = "in_memory";
				this.concurrent = new ConcurrentDatabase(async () => this.idxDb!);
				this.readyResolve();
			} catch (e) {
				this.log.error("IndexDatabase in-memory init failed", e);
				this.state = "unavailable";
				this.idxDb = null;
				this.concurrent = null;
				this.readyResolve();
			}
		})();

		return this.initializing;
	}
}
