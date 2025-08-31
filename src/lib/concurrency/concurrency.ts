/* ------------------------------------------------------------------ */
/*                    Generic concurrency primitives                  */
/* ------------------------------------------------------------------ */

/**
 * Lazily initializes an async value once; resets on failure so callers can retry.
 */
export function asyncLazy<T>(factory: () => Promise<T>): () => Promise<T> {
	let promise: Promise<T> | undefined;
	return () => {
		if (!promise) {
			promise = factory().catch((e) => {
				promise = undefined; // allow retry after failure
				throw e;
			});
		}
		return promise;
	};
}

/**
 * A minimal mutex that serializes async functions.
 * Guarantees release even if the callback throws/rejects.
 */
export class Mutex {
	private chain: Promise<void> = Promise.resolve();
	// Number of holders/waiters reserved. >0 means lock is held or queued.
	private pending = 0;

	/** Acquires the lock, runs `fn`, then releases. */
	async lock<T>(fn: () => Promise<T>): Promise<T> {
		// Reserve immediately to avoid races with tryLock.
		this.pending++;

		// Create a gate that resolves when this holder releases.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		// Chain the gate after the current chain so the next waiter sees it.
		const prev = this.chain;
		this.chain = prev.then(() => gate).catch(() => gate); // ensure chain continues after errors

		// Wait for previous to complete, then run.
		await prev;
		try {
			return await fn();
		} finally {
			this.pending--;
			release(); // let the next waiter proceed
		}
	}

	/** Attempts to run `fn` only if mutex is free; returns null if busy. */
	async tryLock<T>(fn: () => Promise<T>): Promise<T | null> {
		// Fast check: if anyone holds or has reserved the lock, bail.
		if (this.pending > 0) return null;

		// Reserve immediately to avoid a race with another locker starting now.
		this.pending++;

		// Create a gate and link into the chain just like lock().
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prev = this.chain;
		this.chain = prev.then(() => gate).catch(() => gate);

		// If pending was zero, there should be no one ahead; awaiting prev will
		// resolve immediately. If, due to unexpected reentrancy, someone slipped in,
		// pending would have been >0 and we would have returned null above.
		await prev;
		try {
			return await fn();
		} finally {
			this.pending--;
			release();
		}
	}

	/** Whether the mutex is currently held or has queued reservations. */
	isLocked(): boolean {
		return this.pending > 0;
	}
}

/**
 * Serializes async tasks per key using a provided map as storage.
 * Ensures tasks for the same key run strictly one-by-one.
 * Cleans up the key when the last task settles.
 */
export function runExclusiveWithMap<T>(
	map: Map<string, Promise<unknown>>,
	key: string,
	task: () => Promise<T>,
): Promise<T> {
	const existing = map.get(key);
	const chained = existing
		? existing.then(task, task) // Execute task regardless of prior success or failure
		: task();

	// Track this key with the newest promise
	map.set(key, chained as Promise<unknown>);

	const result = new Promise<T>((resolve, reject) => {
		chained.then(resolve, reject);
	});

	// Cleanup once the task settles, but only if still the tail
	chained.finally(() => {
		if (map.get(key) === chained) {
			map.delete(key);
		}
	});

	// Attach a no-op catch handler to prevent unhandled rejection errors in test runners.
	// This does not alter the promise's final resolved/rejected state for the caller.
	chained.catch(() => {
		/* no-op */
	});

	return result as Promise<T>;
}

/**
 * Global convenience: coordinates tasks across all callers of this module.
 * Useful if you want cross-service serialization for shared keys (e.g., vault paths).
 */
const __globalExclusive = new Map<string, Promise<unknown>>();
export function runExclusive<T>(
	key: string,
	task: () => Promise<T>,
): Promise<T> {
	return runExclusiveWithMap(__globalExclusive, key, task);
}

/**
 * Provides per-key serial execution of asynchronous tasks. If a task fails,
 * subsequent tasks for the same key will still be executed after the failure.
 * This is a lightweight, memory-safe alternative to maintaining a pool of mutexes.
 */
export class KeyedQueue {
	private queues = new Map<string, Promise<unknown>>();

	/**
	 * Schedules a task to be run after all previously scheduled tasks for the
	 * same key have completed.
	 * @param key A unique identifier for the queue (e.g., a file path).
	 * @param task The asynchronous function to execute.
	 * @returns A promise that resolves or rejects with the result of the task.
	 */
	public run<T>(key: string, task: () => Promise<T> | T): Promise<T> {
		const existing = this.queues.get(key);
		const taskWrapper = async () => task();

		const current = existing
			? existing.then(taskWrapper, taskWrapper)
			: taskWrapper();

		this.queues.set(key, current);

		const result = new Promise<T>((resolve, reject) => {
			current.then(resolve, reject);
		});

		current.finally(() => {
			if (this.queues.get(key) === current) {
				this.queues.delete(key);
			}
		});

		// Attach a no-op catch handler to prevent unhandled rejection errors in test runners.
		// This does not alter the promise's final resolved/rejected state for the caller.
		current.catch(() => {
			/* no-op */
		});

		return result;
	}

	/**
	 * @internal
	 * FOR TESTING PURPOSES ONLY. Returns the number of active queues.
	 */
	public _getInternalQueueCount(): number {
		return this.queues.size;
	}
}

/**
 * Calculates an optimal concurrency level for I/O-bound pools.
 * It adapts to the host's hardware, provides a safe fallback,
 * and clamps the value to prevent resource exhaustion or underutilization.
 *
 * @param options - Configuration for the calculation.
 * @param options.factor - Multiplier for hardwareConcurrency. Defaults to 0.75 for a good balance.
 * @param options.max - The maximum concurrency allowed. Defaults to 8.
 * @param options.min - The minimum concurrency allowed. Defaults to 2.
 * @param options.fallback - The value to use if hardwareConcurrency is unavailable. Defaults to 4.
 * @returns The calculated optimal concurrency.
 */
export function getOptimalConcurrency(
	options: {
		factor?: number;
		max?: number;
		min?: number;
		fallback?: number;
	} = {},
): number {
	const { factor = 0.75, max = 8, min = 2, fallback = 4 } = options;

	const hc =
		typeof navigator !== "undefined" && (navigator as any).hardwareConcurrency
			? (navigator as any).hardwareConcurrency
			: 0;

	if (hc <= 0) {
		return fallback;
	}

	const calculated = Math.floor(hc * factor);
	return Math.max(min, Math.min(max, calculated));
}
