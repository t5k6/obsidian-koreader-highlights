import { getOptimalConcurrency, isAbortError } from "src/lib/concurrency";
import { throwIfAborted } from "./cancellation";
import { runPool } from "./runPool";

export type ScanResult<U> =
	| { kind: "complete"; items: U[] }
	| { kind: "timedOut"; partialItems: U[]; scannedCount: number };

export async function runConcurrentScan<T, U>(
	iterable: AsyncIterable<T> | Iterable<T>,
	worker: (item: T) => Promise<U | null>,
	options: { signal?: AbortSignal; concurrency?: number } = {},
): Promise<ScanResult<U>> {
	const { signal, concurrency = getOptimalConcurrency({ factor: 0.5 }) } =
		options;

	const results: U[] = [];
	let scanned = 0;

	try {
		const stream = runPool(
			iterable,
			async (item: T) => {
				throwIfAborted(signal);
				scanned++;
				return await worker(item);
			},
			{ concurrency, signal },
		);

		for await (const result of stream) {
			if (result.ok && result.value !== null) {
				results.push(result.value);
			}
			// Errors from individual workers are ignored by default in this aggregator,
			// allowing the scan to continue. The pool will throw for cancellation.
		}

		return { kind: "complete", items: results };
	} catch (e) {
		if (isAbortError(e)) {
			// This catch block is triggered when the pool is aborted.
			return { kind: "timedOut", partialItems: results, scannedCount: scanned };
		}
		// Re-throw any other unexpected, critical errors from the pool itself.
		throw e;
	}
}
