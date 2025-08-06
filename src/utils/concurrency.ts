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

/**
 * A minimal mutex that serializes async functions.
 * Guarantees release even if the callback throws/rejects.
 */
export class Mutex {
	private chain: Promise<void> = Promise.resolve();
	private locked = false;

	/** Acquires the lock, runs `fn`, then releases. */
	async lock<T>(fn: () => Promise<T>): Promise<T> {
		// Create a gate that resolves when previous lock completes.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		// Chain the gate after the current chain.
		const prev = this.chain;
		this.chain = prev.then(() => gate).catch(() => gate); // ensure chain continues after errors

		// Wait for previous to complete, then mark locked.
		await prev;
		this.locked = true;

		try {
			return await fn();
		} finally {
			this.locked = false;
			release(); // let the next waiter proceed
		}
	}

	/** Attempts to run `fn` only if mutex is free; returns null if busy. */
	async tryLock<T>(fn: () => Promise<T>): Promise<T | null> {
		if (this.locked) return null;
		return this.lock(fn);
	}

	/** Whether the mutex is currently held. */
	isLocked(): boolean {
		return this.locked;
	}
}

/**
 * Provides per-key serial execution of asynchronous tasks without retaining locks
 * after the last job for a given key has completed. This is a lightweight,
 * memory-safe alternative to maintaining a pool of mutexes.
 */
export class KeyedQueue {
	private queues = new Map<string, Promise<unknown>>();

	/**
	 * Schedules a task to be run after all previously scheduled tasks for the
	 * same key have completed.
	 * @param key A unique identifier for the queue (e.g., a file path).
	 * @param task The asynchronous function to execute.
	 * @returns A promise that resolves with the result of the task.
	 */
	public run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
		const head = this.queues.get(key) ?? Promise.resolve();

		const next = head
			// Ensures the next task runs even if the previous one failed.
			.catch(() => {})
			.then(task);

		this.queues.set(key, next);

		// Once the task is settled (fulfilled or rejected), check if we can clean up.
		next.finally(() => {
			// If this 'next' promise is still the last one in the chain for this key,
			// it's safe to remove the key from the map.
			if (this.queues.get(key) === next) {
				this.queues.delete(key);
			}
		});

		return next as Promise<T>;
	}
}
