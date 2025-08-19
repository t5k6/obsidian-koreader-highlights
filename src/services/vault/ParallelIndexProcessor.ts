import type { TFile } from "obsidian";
import pLimit from "p-limit";
import { Mutex } from "src/lib/concurrency/concurrency";
import { err, ok } from "src/lib/core/result";
import type { AppFailure, AppResult } from "src/lib/errors";
import type { LoggingService } from "src/services/LoggingService";
import type { BookMetadata, FileMetadataExtractor } from "src/types";

/**
 * Result shape after processing a batch of files.
 */
export interface ProcessResult {
	processed: number; // number of files attempted (includes successes, nulls, and errors)
	failed: number; // number of files that errored during extraction
	errors: { file: string; error: unknown }[];
}

type ScopedLogger = ReturnType<LoggingService["scoped"]>;

/**
 * A high-performance parallel processor that:
 * - Extracts metadata for each file using the provided extractor
 * - Batches upserts into the provided index database (book table)
 * - Reports progress and supports cancellation via AbortSignal
 */
export class ParallelIndexProcessor {
	private readonly log: ScopedLogger;
	private readonly WORKER_COUNT: number;
	private readonly BATCH_SIZE: number;
	private readonly writer: (batch: BookMetadata[]) => Promise<void>;

	constructor(
		private readonly extractor: FileMetadataExtractor,
		writer: (batch: BookMetadata[]) => Promise<void>,
		logging: ScopedLogger,
		opts?: {
			workers?: number;
			batchSize?: number;
		},
	) {
		this.WORKER_COUNT = Math.max(1, opts?.workers ?? 6);
		this.BATCH_SIZE = Math.max(1, opts?.batchSize ?? 64);
		this.log = logging;
		this.writer = writer;
	}

	/**
	 * Process a list of files with concurrency and batch writes.
	 * onProgress is invoked as (current, total) after each file completes extraction.
	 * Returns Result to indicate success or failure instead of throwing exceptions.
	 */
	async processFiles(
		files: TFile[],
		onProgress?: (current: number, total: number) => void,
		signal?: AbortSignal,
	): Promise<AppResult<ProcessResult>> {
		try {
			if (signal?.aborted) {
				return ok({ processed: 0, failed: 0, errors: [] });
			}
			const limiter = pLimit(this.WORKER_COUNT);
			const total = files.length;
			let processedCount = 0;
			const errors: { file: string; error: unknown }[] = [];

			const buffer: BookMetadata[] = [];
			const flushLock = new Mutex();
			let allTasksDone = false;

			const pushAndMaybeFlush = async (item?: BookMetadata) => {
				if (item) buffer.push(item);
				if (
					buffer.length >= this.BATCH_SIZE ||
					(allTasksDone && buffer.length > 0)
				) {
					await flushLock.lock(async () => {
						if (buffer.length === 0) return;
						const batch = buffer.splice(0, buffer.length);
						const flushResult = await this.flushBatch(batch);
						if (flushResult.failed) {
							this.log.warn(
								`Failed to flush batch of size ${batch.length}`,
								flushResult.error,
							);
						}
					});
				}
			};

			const tasks = files.map((file) =>
				limiter(async () => {
					if (signal?.aborted) return;
					try {
						const meta = await this.extractor.extractMetadata(file);
						if (meta) await pushAndMaybeFlush(meta);
					} catch (e) {
						errors.push({ file: file.path, error: e });
					} finally {
						processedCount++;
						onProgress?.(processedCount, total);
					}
				}),
			);

			await Promise.all(tasks);
			allTasksDone = true;
			await pushAndMaybeFlush();

			return ok({ processed: processedCount, failed: errors.length, errors });
		} catch (e) {
			this.log.error(
				"ParallelIndexProcessor.processFiles failed unexpectedly",
				e,
			);
			return err({
				kind: "WRITE_FAILED",
				message: "Failed to process files",
				cause: e,
			} as AppFailure);
		}
	}

	private async flushBatch(batch: BookMetadata[]): Promise<{
		failed: boolean;
		error?: unknown;
	}> {
		if (batch.length === 0) return { failed: false };
		try {
			await this.writer(batch);
			return { failed: false };
		} catch (e) {
			return { failed: true, error: e };
		}
	}
}
