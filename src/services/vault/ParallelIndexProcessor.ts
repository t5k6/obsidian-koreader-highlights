import type { TFile } from "obsidian";
import pLimit from "p-limit";
import type { LoggingService } from "src/services/LoggingService";
import type { BookMetadata, FileMetadataExtractor } from "src/types";
import type { ConcurrentDatabase } from "src/utils/ConcurrentDatabase";

/**
 * Result shape after processing a batch of files.
 */
export interface ProcessResult {
	processed: number;
	failed: number;
	errors: { file: string; error: unknown }[];
}

/**
 * A high-performance parallel processor that:
 * - Extracts metadata for each file using the provided extractor
 * - Batches upserts into the provided index database (book table)
 * - Reports progress and supports cancellation via AbortSignal
 */
export class ParallelIndexProcessor {
	private readonly log;
	private readonly WORKER_COUNT: number;
	private readonly BATCH_SIZE: number;

	constructor(
		private readonly extractor: FileMetadataExtractor,
		private readonly db: ConcurrentDatabase,
		private readonly logging: LoggingService,
		opts?: {
			workers?: number;
			batchSize?: number;
		},
	) {
		this.WORKER_COUNT = Math.max(1, opts?.workers ?? 6);
		this.BATCH_SIZE = Math.max(1, opts?.batchSize ?? 64);
		this.log = this.logging.scoped("ParallelIndexProcessor");
	}

	/**
	 * Process a list of files with concurrency and batch writes.
	 * onProgress is invoked as (current, total) after each file completes extraction.
	 */
	async processFiles(
		files: TFile[],
		onProgress?: (current: number, total: number) => void,
		signal?: AbortSignal,
	): Promise<ProcessResult> {
		const limiter = pLimit(this.WORKER_COUNT);
		const total = files.length;
		let processedCount = 0;

		const errors: { file: string; error: unknown }[] = [];

		const tasks = files.map((file) =>
			limiter(async () => {
				if (signal?.aborted) return null;

				try {
					const meta = await this.extractor.extractMetadata(file);
					return meta;
				} catch (e) {
					errors.push({ file: file.path, error: e });
					return null;
				} finally {
					processedCount++;
					onProgress?.(processedCount, total);
				}
			}),
		);

		const all = await Promise.all(tasks);
		const valid: BookMetadata[] = all.filter(
			(m): m is BookMetadata => m !== null,
		);

		if (signal?.aborted) {
			return {
				processed: processedCount,
				failed: total - processedCount,
				errors,
			};
		}

		// Flush to DB in batches
		for (let i = 0; i < valid.length; i += this.BATCH_SIZE) {
			const batch = valid.slice(i, i + this.BATCH_SIZE);
			await this.flushBatch(batch);
		}

		return {
			processed: valid.length,
			failed: total - valid.length,
			errors,
		};
	}

	/**
	 * Upsert a batch of BookMetadata entries into the index.
	 */
	private async flushBatch(batch: BookMetadata[]): Promise<void> {
		if (batch.length === 0) return;
		try {
			await this.db.execute((database) => {
				const sql = `INSERT INTO book(key,id,title,authors,vault_path) VALUES(?,?,?,?,?)
                     ON CONFLICT(key) DO UPDATE SET
                        id=COALESCE(excluded.id, book.id),
                        title=excluded.title,
                        authors=excluded.authors,
                        vault_path=excluded.vault_path;`;
				const stmt = database.prepare(sql);
				try {
					for (const { key, title, authors, vaultPath } of batch) {
						stmt.run([key, null, title, authors, vaultPath ?? null]);
					}
				} finally {
					stmt.free();
				}
			}, true);
		} catch (e) {
			this.log.warn(`Failed to flush batch of size ${batch.length}`, e);
		}
	}
}
