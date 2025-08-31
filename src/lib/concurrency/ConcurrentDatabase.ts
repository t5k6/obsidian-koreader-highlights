import type { Database } from "sql.js";
import { throwIfAborted } from "./cancellation";
import { asyncLazy, Mutex } from "./concurrency";

/**
 * Provides serialized access to a sql.js Database instance.
 * Ensures that only one operation accesses the database at a time.
 */
export class ConcurrentDatabase {
	private mutex = new Mutex();
	private readonly getDbLazy: () => Promise<Database>;

	constructor(
		private readonly getDb: () => Promise<Database>,
		private readonly markDirty?: (isDirty: boolean) => void,
	) {
		this.getDbLazy = asyncLazy<Database>(this.getDb);
	}

	/**
	 * Execute a callback with exclusive access to the database.
	 * If isWrite is true, mark the DB as dirty after the callback.
	 */
	async execute<T>(
		callback: (db: Database) => Promise<T> | T,
		isWrite = false,
		signal?: AbortSignal,
	): Promise<T> {
		throwIfAborted(signal);
		// Initialize DB without holding the mutex; serialize the callback execution only.
		// Invoke the lazy function directly.
		const db = await this.getDbLazy();
		return this.mutex.lock(async () => {
			throwIfAborted(signal);
			const result = await callback(db);
			if (isWrite && this.markDirty) {
				this.markDirty(true);
			}
			return result;
		});
	}

	/**
	 * Try to execute a callback only if the lock is currently free.
	 * Returns null if the database is busy.
	 */
	async tryExecute<T>(
		callback: (db: Database) => Promise<T> | T,
		isWrite = false,
		signal?: AbortSignal,
	): Promise<T | null> {
		throwIfAborted(signal);
		// Ensure DB is initialized (once) before attempting to acquire the lock.
		const db = await this.getDbLazy();
		return this.mutex.tryLock(async () => {
			throwIfAborted(signal);
			const result = await callback(db);
			if (isWrite && this.markDirty) {
				this.markDirty(true);
			}
			return result;
		});
	}

	isLocked(): boolean {
		return this.mutex.isLocked();
	}

	private txCounter = 0;

	/**
	 * Safe-by-default write transaction.
	 * - Supports sync and async callbacks.
	 * - Keeps the SAVEPOINT and the mutex held until the callback finishes.
	 * - Supports nesting via SAVEPOINT.
	 */
	public async writeTx<T>(
		fn: (db: Database) => T | Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		throwIfAborted(signal);
		const txId = `ko_tx_${++this.txCounter}`;
		return this.execute(
			async (database) => {
				throwIfAborted(signal);
				database.run(`SAVEPOINT ${txId};`);
				try {
					const result = await fn(database);
					database.run(`RELEASE SAVEPOINT ${txId};`);
					this.markDirty?.(true);
					return result;
				} catch (e) {
					try {
						database.run(`ROLLBACK TO SAVEPOINT ${txId};`);
						database.run(`RELEASE SAVEPOINT ${txId};`);
					} catch {
						// ignore rollback errors
					}
					throw e;
				}
			},
			true,
			signal,
		);
	}
}
