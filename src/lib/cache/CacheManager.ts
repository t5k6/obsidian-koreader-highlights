import type { LoggingService } from "src/services/LoggingService";
import type { AsyncLoader, Cache, Disposable } from "src/types";
import { memoizeAsync, SimpleCache } from "./SimpleCache";
import type { IterableCache } from "./types";

/**
 * A DI-managed service to create, track, and invalidate all caches for the plugin.
 * This is the single, public entry point for cache management within services.
 */
export class CacheManager implements Disposable {
	private readonly log; // This can be undefined
	private readonly registry = new Map<string, Cache<unknown, unknown>>();

	constructor(private loggingService?: LoggingService) {
		this.log = this.loggingService?.scoped("CacheManager");
	}

	/** Creates and registers a new LRU-like cache. */
	public createLru<K, V>(name: string, max = 100): IterableCache<K, V> {
		const cache = new SimpleCache<K, V>(max);
		return this.register(name, cache);
	}

	/** Creates and registers a new Map-backed cache without eviction. */
	public createMap<K, V>(name: string): IterableCache<K, V> {
		const cache = new SimpleCache<K, V>();
		return this.register(name, cache);
	}

	/** Registers an existing cache instance. */
	public register<T extends Cache<any, any>>(name: string, cache: T): T {
		if (this.registry.has(name)) {
			this.log?.warn(`Overwriting already registered cache "${name}"`);
		}
		this.registry.set(name, cache);
		return cache;
	}

	/** Alias for register() to emphasize adopting third-party caches. */
	public adopt<T extends Cache<any, any>>(name: string, cache: T): T {
		return this.register(name, cache);
	}

	/** Retrieves a registered cache by name. */
	public get<T extends Cache<any, any>>(name: string): T {
		const c = this.registry.get(name) as T | undefined;
		if (!c) throw new Error(`Cache "${name}" not found`);
		return c;
	}

	/** Clears caches by pattern; returns number cleared. Supports wildcards * and ?. */
	public clear(pattern?: string): number {
		let clearedCount = 0;
		if (!pattern) {
			clearedCount = this.registry.size;
			for (const cache of this.registry.values()) {
				try {
					cache.clear();
				} catch (e) {
					this.log?.warn(`Error while clearing cache`, e);
				}
			}
		} else {
			const regex = new RegExp(
				"^" +
					pattern
						.replace(/[.+^${}()|[\]\\]/g, "\\$&")
						.replace(/\*/g, ".*")
						.replace(/\?/g, ".") +
					"$",
			);
			for (const [name, cache] of this.registry) {
				if (regex.test(name)) {
					try {
						cache.clear();
						clearedCount++;
					} catch (e) {
						this.log?.warn(`Error while clearing cache "${name}"`, e);
					}
				}
			}
		}

		this.log?.info(
			pattern
				? `Cleared ${clearedCount} cache(s) via pattern "${pattern}".`
				: `Cleared all ${clearedCount} cache(s).`,
		);
		return clearedCount;
	}

	/** Predicate-based clearing for advanced scenarios. */
	public clearWhere(
		pred: (name: string, cache: Cache<unknown, unknown>) => boolean,
	): number {
		let clearedCount = 0;
		for (const [name, cache] of this.registry) {
			if (pred(name, cache)) {
				try {
					cache.clear();
					clearedCount++;
				} catch (e) {
					this.log?.warn(`Error while clearing cache "${name}"`, e);
				}
			}
		}
		if (clearedCount > 0) {
			this.log?.info(`Cleared ${clearedCount} cache(s) via predicate.`);
		}
		return clearedCount;
	}

	/** Wrap a loader with in-flight caching using a registered LRU Promise cache. */
	public createMemoized<K, V>(
		name: string,
		loader: AsyncLoader<K, V>,
		max = 100,
	): (key: K) => Promise<V> {
		const promiseCache = this.createLru<K, Promise<V>>(name, max);
		return memoizeAsync(promiseCache, loader);
	}

	public keys(): string[] {
		return Array.from(this.registry.keys());
	}

	/** Clears all registered caches on disposal. */
	public dispose(): void {
		const count = this.registry.size;
		for (const cache of this.registry.values()) {
			cache.clear();
		}
		this.registry.clear();
		this.log?.info(`Disposed and cleared all ${count} caches.`);
	}
}
