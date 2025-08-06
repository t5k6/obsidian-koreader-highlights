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
}
