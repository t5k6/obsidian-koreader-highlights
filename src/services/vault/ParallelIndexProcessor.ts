import type { TFile } from "obsidian";
import {
	getOptimalConcurrency,
	isAbortError,
	runPool,
} from "src/lib/concurrency";
import { err, isErr, ok } from "src/lib/core/result";
import type { AppFailure, AppResult } from "src/lib/errors/types";
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
		this.WORKER_COUNT = Math.max(1, opts?.workers ?? getOptimalConcurrency());
		this.BATCH_SIZE = Math.max(1, opts?.batchSize ?? 64);
		this.log = logging;
		this.writer = writer;
	}

	public async processFiles(
		filesStream: AsyncIterable<TFile> | Iterable<TFile>,
		onProgress: (current: number) => void,
		signal?: AbortSignal,
	): Promise<AppResult<ProcessResult>> {
		// Move declarations outside the try block to widen their scope.
		let processedCount = 0;
		const errors: { file: string; error: unknown }[] = [];

		try {
			const batch: BookMetadata[] = [];

			const resultsStream = runPool(
				filesStream,
				(file: TFile) => this.extractor.extractMetadata(file),
				{ concurrency: this.WORKER_COUNT, signal },
			);

			for await (const res of resultsStream) {
				processedCount++;
				onProgress(processedCount);

				if (isErr(res)) {
					const errorItem = res.error.item as TFile | undefined;
					errors.push({
						file: errorItem?.path ?? "unknown",
						error: res.error.error,
					});
				} else if (res.value) {
					batch.push(res.value);
					if (batch.length >= this.BATCH_SIZE) {
						await this.writer(batch.splice(0, batch.length));
					}
				}
			}

			if (batch.length > 0) {
				await this.writer(batch);
			}

			return ok({ processed: processedCount, failed: errors.length, errors });
		} catch (e) {
			if (isAbortError(e)) {
				this.log.info("Parallel processing was aborted by user.");
				return ok({ processed: processedCount, failed: errors.length, errors });
			}

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
}
