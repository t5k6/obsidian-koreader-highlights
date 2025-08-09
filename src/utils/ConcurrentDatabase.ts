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
	 * Convenience method for write transactions that supports safe nesting via SAVEPOINT.
	 * The callback MUST be synchronous (no awaits) to avoid holding the lock while pending.
	 */
	public async writeTx<T>(fn: (db: Database) => T): Promise<T> {
		return this.execute((database) => {
			// Use a SAVEPOINT so nested calls do not error and can be composed.
			database.run("SAVEPOINT ko_tx;");
			try {
				const result = fn(database);
				// Enforce synchronous callbacks: if a Promise/thenable is returned, instruct caller to use writeTxAsync
				if (result && typeof (result as any).then === "function") {
					try {
						database.run("ROLLBACK TO SAVEPOINT ko_tx;");
						database.run("RELEASE SAVEPOINT ko_tx;");
					} catch {}
					throw new Error(
						"ConcurrentDatabase.writeTx callback must be synchronous. Use writeTxAsync for async operations.",
					);
				}
				database.run("RELEASE SAVEPOINT ko_tx;");
				this.markDirty?.(true);
				return result as T;
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
	 * Async variant of writeTx that keeps the SAVEPOINT active until the async body resolves.
	 * This prevents releasing the SAVEPOINT before the async operations complete.
	 */
	public async writeTxAsync<T>(fn: (db: Database) => Promise<T>): Promise<T> {
		return this.execute(async (database) => {
			database.run("SAVEPOINT ko_tx;");
			try {
				const result = await fn(database);
				database.run("RELEASE SAVEPOINT ko_tx;");
				this.markDirty?.(true);
				return result;
			} catch (e) {
				try {
					database.run("ROLLBACK TO SAVEPOINT ko_tx;");
					database.run("RELEASE SAVEPOINT ko_tx;");
				} catch {}
				throw e;
			}
		}, false);
	}
}
