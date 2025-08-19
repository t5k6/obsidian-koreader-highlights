import type { Cache } from "src/types";
import type { IterableCache } from "./types";

/**
 * A standalone, dependency-free cache utility with optional LRU eviction.
 * Intended for use in pure, functional-core modules that do not use DI.
 */
export class SimpleCache<K, V>
	extends Map<K, V>
	implements IterableCache<K, V>
{
	constructor(private maxSize?: number) {
		super();
	}

	get(key: K): V | undefined {
		const value = super.get(key);
		if (value !== undefined && this.maxSize) {
			super.delete(key); // Move to end for LRU
			super.set(key, value);
		}
		return value;
	}

	set(key: K, value: V): this {
		if (this.maxSize) {
			if (super.has(key)) super.delete(key);
			super.set(key, value);
			if (this.size > this.maxSize) {
				const firstKey = this.keys().next().value as K | undefined;
				if (firstKey !== undefined) super.delete(firstKey);
			}
		} else {
			super.set(key, value);
		}
		return this;
	}

	public deleteWhere(predicate: (key: K, value: V) => boolean): number {
		let count = 0;
		for (const [k, v] of this) {
			if (predicate(k, v)) {
				this.delete(k);
				count++;
			}
		}
		return count;
	}
}

/**
 * A pure, higher-order function that wraps an async loader with in-flight
 * promise caching to prevent redundant concurrent calls for the same key.
 */
export function memoizeAsync<K, V>(
	cache: Cache<K, Promise<V>>,
	loader: (key: K) => Promise<V>,
): (key: K) => Promise<V> {
	return (key: K) => {
		const existing = cache.get(key);
		if (existing) return existing;

		const promise = loader(key).catch((err) => {
			cache.delete(key); // Allow retry on failure
			throw err;
		});

		cache.set(key, promise);
		return promise;
	};
}
