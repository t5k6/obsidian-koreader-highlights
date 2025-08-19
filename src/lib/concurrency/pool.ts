import pLimit from "p-limit";
import { throwIfAborted } from "src/lib/concurrency/cancellation";

/**
 * Headless concurrency pool. Executes tasks for each item with a concurrency limit.
 * No UI side-effects.
 */
export async function runPool<T, R>(
	items: T[],
	maxConcurrent: number,
	task: (item: T, signal: AbortSignal) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	if (maxConcurrent <= 0) {
		throw new Error("maxConcurrent must be >= 1");
	}
	if (signal) throwIfAborted(signal);
	// Respect explicit 1-thread callers; use hardwareConcurrency only as an upper bound.
	const hw =
		typeof navigator !== "undefined" && (navigator as any).hardwareConcurrency
			? (navigator as any).hardwareConcurrency
			: Infinity;
	const poolSize = Math.max(1, Math.min(maxConcurrent, hw));

	const limit = pLimit(poolSize);
	const tasks = items.map((item) =>
		limit(async () => {
			if (signal) throwIfAborted(signal);
			return task(item, signal as AbortSignal);
		}),
	);
	return Promise.all(tasks);
}
