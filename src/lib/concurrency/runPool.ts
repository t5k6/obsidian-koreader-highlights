import { err, ok, type Result } from "src/lib/core/result";
import { isAbortError, throwIfAborted } from "./cancellation";

export interface PoolOptions {
	concurrency: number;
	signal?: AbortSignal;
}

/**
 * A robust, streaming-capable concurrency pool that is resilient to the "lost update"
 * problem and correctly handles all cancellation scenarios.
 *
 * It processes an iterable with a fixed concurrency limit and yields Results as they complete.
 * This is the canonical concurrency primitive for the plugin.
 */
export async function* runPool<T, R>(
	iterable: AsyncIterable<T> | Iterable<T>,
	worker: (item: T) => Promise<R>,
	opts: PoolOptions,
): AsyncIterable<Result<R, { item: T; error: unknown }>> {
	throwIfAborted(opts.signal);

	const iterator = (
		Symbol.asyncIterator in iterable
			? iterable[Symbol.asyncIterator]()
			: iterable[Symbol.iterator]()
	) as AsyncIterator<T> | Iterator<T>;

	const workers: Promise<void>[] = [];
	const results: Result<R, { item: T; error: unknown }>[] = [];
	let resolveNext: ((value: void) => void) | null = null;
	let isDone = false;
	let poolError: unknown = null;

	const workerFn = async () => {
		while (true) {
			throwIfAborted(opts.signal);
			const { value, done } = await iterator.next();
			if (done) {
				return; // Iterator is exhausted.
			}

			try {
				const resultValue = await worker(value);
				throwIfAborted(opts.signal); // Additional check after processing item
				results.push(ok(resultValue));
			} catch (e) {
				if (isAbortError(e)) throw e; // Propagate aborts to stop the pool.
				results.push(err({ item: value, error: e }));
			} finally {
				resolveNext?.(); // Signal that a result is available.
			}
		}
	};

	for (let i = 0; i < opts.concurrency; i++) {
		workers.push(workerFn());
	}

	const allWorkersDone = Promise.all(workers)
		.catch((e) => {
			// Capture the first critical error (like an AbortError) from any worker.
			if (!poolError) {
				poolError = e;
			}
		})
		.finally(() => {
			isDone = true;
			resolveNext?.(); // Final signal to drain any remaining results.
		});

	while (!isDone || results.length > 0) {
		if (poolError) {
			// If a critical error occurred, stop yielding and re-throw.
			throw poolError;
		}

		while (results.length > 0) {
			yield results.shift()!;
		}

		if (!isDone) {
			// Wait for the next result to become available or for the pool to finish.
			await new Promise<void>((resolve) => {
				resolveNext = resolve;
			});
			resolveNext = null;
		}
	}

	await allWorkersDone;
	if (poolError) {
		throw poolError;
	}
}
