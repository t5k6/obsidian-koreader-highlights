/* ------------------------------------------------------------------ */
/*                    Generic concurrency primitives                  */
/* ------------------------------------------------------------------ */

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
