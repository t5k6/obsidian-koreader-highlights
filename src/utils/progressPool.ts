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
	const poolSize = Math.min(
		maxConcurrent,
		Math.max(2, navigator.hardwareConcurrency || 4),
	);

	return withProgress(app, items.length, async (tick, signal) => {
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
	});
}
