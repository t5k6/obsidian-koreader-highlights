import type { Database } from "sql.js";
import type { ConcurrentDatabase } from "src/lib/concurrency/ConcurrentDatabase";

export interface IndexDbExecutor {
	read<T>(
		fn: (db: Database) => T | Promise<T>,
		signal?: AbortSignal,
	): Promise<T>;
	write<T>(
		fn: (db: Database) => T | Promise<T>,
		signal?: AbortSignal,
	): Promise<T>;
}

/**
 * Adapter turning ConcurrentDatabase into the IndexDbExecutor interface.
 */
export class ConcurrentDbExecutor implements IndexDbExecutor {
	constructor(private readonly concurrent: ConcurrentDatabase) {}

	read<T>(
		fn: (db: Database) => T | Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		// Non-transactional, shared read access.
		return this.concurrent.execute(fn, false, signal);
	}

	write<T>(
		fn: (db: Database) => T | Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		// Safe transactional write using SAVEPOINTs.
		return this.concurrent.writeTx(fn, signal);
	}
}
