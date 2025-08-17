import type { App } from "obsidian";
import pLimit from "p-limit";
import { withProgress } from "src/lib/ui/progress";

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
			const limit = pLimit(poolSize);
			const tasks = items.map((item) =>
				limit(async () => {
					if (signal.aborted)
						throw new DOMException("Aborted by user", "AbortError");
					const r = await task(item);
					tick();
					return r;
				}),
			);
			return Promise.all(tasks);
		},
		{ title: options.title },
	);
}
