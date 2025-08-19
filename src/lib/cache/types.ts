import type { Cache } from "src/types";

/**
 * Extension of the minimal Cache that supports iterating keys.
 * Enables utility operations like predicate-based deletion without
 * exposing underlying implementation details.
 */
export interface IterableCache<K, V> extends Cache<K, V> {
	keys(): Iterable<K>;
	deleteWhere(predicate: (key: K, value: V) => boolean): number;
}
