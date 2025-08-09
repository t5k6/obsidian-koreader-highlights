import type { App } from "obsidian";
import { asyncPool } from "src/utils/concurrency";
import { withProgress } from "src/utils/progress";

export async function runPoolWithProgress<T, R>(
	app: App,
	items: T[],
	options: {
		title?: string;
		maxConcurrent: number;
		task: (item: T) => Promise<R>;
	},
): Promise<R[]> {
	const { maxConcurrent, task } = options;
	// Respect explicit 1-thread callers; use hardwareConcurrency only as an upper bound.
	const hw =
		typeof navigator !== "undefined" && (navigator as any).hardwareConcurrency
			? (navigator as any).hardwareConcurrency
			: Infinity;
	const poolSize = Math.max(1, Math.min(maxConcurrent, hw));

	return withProgress(
		app,
		items.length,
		async (tick, signal) => {
			const results = await asyncPool(
				poolSize,
				items,
				async (item) => {
					if (signal.aborted)
						throw new DOMException("Aborted by user", "AbortError");
					const r = await task(item);
					tick();
					return r;
				},
				signal,
			);
			return results;
		},
		{ title: options.title },
	);
}
