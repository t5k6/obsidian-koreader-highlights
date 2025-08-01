/* ------------------------------------------------------------------ */
/*                    Generic concurrency primitives                  */
/* ------------------------------------------------------------------ */

/**
 * Limits the number of concurrently executing asynchronous tasks.
 * Tasks are queued and executed as capacity becomes available.
 *
 *   const limiter = new ConcurrencyLimiter(8);
 *   await limiter.schedule(() => fetch(url));
 */
export class ConcurrencyLimiter {
	private active = 0;
	private readonly queue: (() => void)[] = [];

	constructor(private readonly capacity = 8) {}

	/**
	 * Schedules a task to be executed, respecting the concurrency limit.
	 * Tasks are queued if the limit is reached.
	 * @param task - Async function to execute
	 * @returns Promise resolving to the task's result
	 */
	async schedule<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= this.capacity) {
			await new Promise<void>((res) => this.queue.push(res));
		}
		this.active++;
		try {
			return await task();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

/**
 * Classic “promise-pool” that maps an async iterator over an array.
 *
 *   const results = await asyncPool(4, items, async (x) => doWork(x));
 */
export async function asyncPool<T, R>(
	poolLimit: number,
	array: readonly T[],
	iteratorFn: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results: R[] = [];
	const executing = new Set<Promise<void>>();

	for (const [index, item] of array.entries()) {
		if (signal?.aborted) {
			throw signal.reason ?? new DOMException("Aborted", "AbortError");
		}

		const p = Promise.resolve()
			.then(() => iteratorFn(item, index))
			.then((res) => {
				results[index] = res;
			});

		executing.add(p);
		p.finally(() => executing.delete(p));

		if (executing.size >= poolLimit) {
			await Promise.race(executing);
		}
	}
	await Promise.all(executing);
	return results;
}
