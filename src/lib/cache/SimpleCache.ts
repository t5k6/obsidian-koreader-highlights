import type { Cache } from "src/types";
import type { IterableCache } from "./types";

// A typed internal entry to store value and timestamp.
interface CacheEntry<V> {
	value: V;
	timestamp: number;
}

/**
 * A standalone, dependency-free cache utility with optional LRU and/or TTL eviction.
 * This is the canonical cache implementation for the plugin.
 *
 * - If only `maxSize` is provided, it's an LRU cache.
 * - If only `ttlMs` is provided, it's a TTL cache.
 * - If both are provided, entries are evicted by both LRU and TTL policies.
 */
export class SimpleCache<K, V> implements IterableCache<K, V> {
	private readonly internalMap = new Map<K, CacheEntry<V>>();

	constructor(
		private readonly maxSize?: number,
		private readonly ttlMs?: number,
	) {}

	get size(): number {
		// Note: size may include expired entries until the next get/keys() call purges them.
		return this.internalMap.size;
	}

	get(key: K): V | undefined {
		const entry = this.internalMap.get(key);
		if (!entry) {
			return undefined;
		}

		if (this.isExpired(entry.timestamp)) {
			this.internalMap.delete(key);
			return undefined;
		}

		// For LRU: move the accessed item to the end of the map.
		if (this.maxSize) {
			this.internalMap.delete(key);
			this.internalMap.set(key, entry);
		}

		return entry.value;
	}

	set(key: K, value: V): this {
		const newEntry: CacheEntry<V> = { value, timestamp: Date.now() };

		// For LRU: if the key already exists, delete it to move it to the end.
		if (this.maxSize && this.internalMap.has(key)) {
			this.internalMap.delete(key);
		}

		this.internalMap.set(key, newEntry);

		// For LRU: if the cache is over size, evict the oldest entry.
		if (this.maxSize && this.internalMap.size > this.maxSize) {
			const firstKey = this.internalMap.keys().next().value as K | undefined;
			if (firstKey !== undefined) {
				this.internalMap.delete(firstKey);
			}
		}

		return this;
	}

	has(key: K): boolean {
		return this.get(key) !== undefined;
	}

	clear(): void {
		this.internalMap.clear();
	}

	delete(key: K): boolean {
		return this.internalMap.delete(key);
	}

	*keys(): IterableIterator<K> {
		// This generator lazily purges expired entries as it iterates.
		for (const [key, entry] of this.internalMap) {
			if (this.isExpired(entry.timestamp)) {
				this.internalMap.delete(key);
				continue;
			}
			yield key;
		}
	}

	deleteWhere(predicate: (key: K, value: V) => boolean): number {
		let count = 0;
		// Iterate over a copy of the keys to safely delete from the map during iteration.
		for (const key of [...this.internalMap.keys()]) {
			const entry = this.internalMap.get(key);
			if (!entry) continue;

			if (this.isExpired(entry.timestamp)) {
				this.internalMap.delete(key);
				count++;
				continue;
			}

			// Correctly pass the unwrapped value to the predicate.
			if (predicate(key, entry.value)) {
				this.internalMap.delete(key);
				count++;
			}
		}
		return count;
	}

	private isExpired(timestamp: number): boolean {
		return !!this.ttlMs && Date.now() - timestamp > this.ttlMs;
	}
}

/**
 * A pure, higher-order function that wraps an async loader with in-flight
 * promise caching to prevent redundant concurrent calls for the same key.
 */
export function memoizeAsync<K, V, R = V>(
	cache: Cache<K, Promise<R>>,
	loader: (key: K) => Promise<R>,
): (key: K) => Promise<R> {
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
