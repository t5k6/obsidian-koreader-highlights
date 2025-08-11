import type { Database } from "sql.js";
import { Mutex } from "./concurrency";

/**
 * Provides serialized access to a sql.js Database instance.
 * Ensures that only one operation accesses the database at a time.
 */
export class ConcurrentDatabase {
	private mutex = new Mutex();

	constructor(
		private readonly getDb: () => Promise<Database>,
		private readonly markDirty?: (isDirty: boolean) => void,
	) {}

	/**
	 * Execute a callback with exclusive access to the database.
	 * If isWrite is true, mark the DB as dirty after the callback.
	 */
	async execute<T>(
		callback: (db: Database) => Promise<T> | T,
		isWrite = false,
	): Promise<T> {
		return this.mutex.lock(async () => {
			const db = await this.getDb();
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
	): Promise<T | null> {
		return this.mutex.tryLock(async () => {
			const db = await this.getDb();
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

	/**
	 * Safe-by-default write transaction.
	 * - Supports sync and async callbacks.
	 * - Keeps the SAVEPOINT and the mutex held until the callback finishes.
	 * - Supports nesting via SAVEPOINT.
	 */
	public async writeTx<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
		return this.execute(async (database) => {
			database.run("SAVEPOINT ko_tx;");
			try {
				const result = await fn(database); // awaits if Promise
				database.run("RELEASE SAVEPOINT ko_tx;");
				this.markDirty?.(true);
				return result;
			} catch (e) {
				try {
					database.run("ROLLBACK TO SAVEPOINT ko_tx;");
					database.run("RELEASE SAVEPOINT ko_tx;");
				} catch {
					// ignore rollback errors
				}
				throw e;
			}
		}, false);
	}

	/**
	 * @deprecated Use writeTx instead. This is now an alias that behaves identically.
	 */
	public writeTxAsync<T>(fn: (db: Database) => Promise<T>): Promise<T> {
		return this.writeTx(fn);
	}
}
