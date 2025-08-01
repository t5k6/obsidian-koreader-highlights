import type { AsyncLoader, Cache, Disposable } from "src/types";
import { logger } from "../logging";
import { LruCache } from "./LruCache";

/**
 * A DI-managed service to create, track, and invalidate all caches for the plugin.
 * This centralizes cache management, removing duplicated logic from other services.
 */
export class CacheManager implements Disposable {
	private caches = new Map<string, Cache<unknown, unknown>>();

	/* ---------- Factory Methods ---------- */

	/**
	 * Creates and registers a new LruCache.
	 * @param name A unique, namespaced identifier (e.g., "template.raw").
	 * @param max The maximum number of items in the cache.
	 */
	public createLru<K, V>(name: string, max = 100): LruCache<K, V> {
		const cache = new LruCache<K, V>(max);
		return this.register(name, cache);
	}

	/**
	 * Creates and registers a new standard Map that conforms to the Cache interface.
	 * @param name A unique, namespaced identifier (e.g., "sdr.dir").
	 */
	public createMap<K, V>(name: string): Map<K, V> {
		// A standard Map already implements the Cache interface.
		return this.register(name, new Map<K, V>());
	}

	/* ---------- Core API ---------- */

	/**
	 * Registers an existing cache instance with the manager.
	 * @param name A unique identifier for the cache.
	 * @param cache The cache instance to register.
	 */
	public register<T extends Cache<unknown, unknown>>(
		name: string,
		cache: T,
	): T {
		if (this.caches.has(name)) {
			logger.warn(
				`CacheManager: Overwriting already registered cache "${name}"`,
			);
		}
		this.caches.set(name, cache);
		return cache;
	}

	/**
	 * Retrieves a registered cache by its name.
	 * @throws If no cache with the given name is found.
	 */
	public get<T extends Cache<unknown, unknown>>(name: string): T {
		const c = this.caches.get(name);
		if (!c) throw new Error(`Cache "${name}" not found`);
		return c as T;
	}

	/**
	 * Clears caches. If no pattern is provided, clears all caches.
	 * Supports simple wildcard `*` matching for targeted clearing.
	 * @param pattern An optional pattern (e.g., "sdr.*" or "template.raw").
	 */
	public clear(pattern?: string): void {
		if (!pattern) {
			for (const cache of this.caches.values()) {
				cache.clear();
			}
			logger.info(`CacheManager: Cleared all ${this.caches.size} caches.`);
			return;
		}

		const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
		for (const [name, cache] of this.caches.entries()) {
			if (regex.test(name)) {
				cache.clear();
				logger.info(
					`CacheManager: Cleared cache "${name}" via pattern "${pattern}"`,
				);
			}
		}
	}

	/**
	 * Clears all registered caches on disposal.
	 */
	public dispose(): void {
		this.clear();
		this.caches.clear();
		logger.info("CacheManager: Disposed and cleared registry.");
	}
}

/**
 * A higher-order function that wraps an async loader with in-flight
 * promise caching to prevent redundant concurrent calls for the same key.
 * @param cache A cache to store the promises.
 * @param loader The async function that loads the data.
 */
export function memoizeAsync<K, V>(
	cache: Cache<K, Promise<V>>,
	loader: AsyncLoader<K, V>,
): (key: K) => Promise<V> {
	return (key: K) => {
		let hit = cache.get(key);
		if (hit) {
			return hit;
		}

		hit = loader(key).catch((err) => {
			// On failure, remove the failed promise from the cache
			// so that subsequent calls can retry.
			cache.delete(key);
			throw err;
		});

		cache.set(key, hit);
		return hit;
	};
}
