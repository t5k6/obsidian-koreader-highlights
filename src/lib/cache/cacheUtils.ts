import type { IterableCache } from "src/lib/cache/types";

/**
 * A higher-order function that wraps a pure computation with a stateful caching layer.
 * It uses a provided hasher to generate a stable, primitive cache key from complex inputs.
 * This is the canonical implementation for the "caching shell" pattern.
 *
 * @param cache The cache instance, which MUST be keyed by `string`.
 * @param hasher A pure function that takes the original arguments and returns a stable `string` key.
 * @param pureFn The pure, stateless computation function to be memoized.
 * @returns A new stateful function that performs the caching logic.
 */
export function memoizePure<TArgs, TReturn>(
	cache: IterableCache<string, TReturn>,
	hasher: (args: TArgs) => string,
	pureFn: (args: TArgs) => TReturn,
): (args: TArgs) => TReturn {
	return (args: TArgs) => {
		// 1. [SHELL] Use the hasher to create a stable string key.
		const key = hasher(args);

		// 2. [SHELL] Check the string-keyed cache.
		const cached = cache.get(key);
		if (cached !== undefined) {
			return cached;
		}

		// 3. [CORE] If not cached, execute the pure function.
		const result = pureFn(args);

		// 4. [SHELL] Store the result in the cache before returning.
		cache.set(key, result);
		return result;
	};
}
