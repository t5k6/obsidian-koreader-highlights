/**
 * Generic object manipulation utilities.
 * Pure functions for cloning, sorting, and other transformations.
 */

/**
 * Recursively canonicalizes a value by sorting object keys.
 * Ensures a stable representation for serialization or comparison.
 * @param val The value to canonicalize.
 * @returns A deep-cloned, canonicalized version of the value.
 */
export function deepCanonicalize(val: unknown): unknown {
	if (Array.isArray(val)) {
		return val.map((v) => deepCanonicalize(v));
	}
	if (val && typeof val === "object") {
		const obj = val as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		const out: Record<string, unknown> = {};
		for (const k of keys) {
			out[k] = deepCanonicalize(obj[k]);
		}
		return out;
	}
	return val;
}

/**
 * Performs a deep equality comparison between two values.
 * Handles objects, arrays, and primitives recursively.
 * @param a The first value to compare.
 * @param b The second value to compare.
 * @returns True if the values are deeply equal, false otherwise.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;

	if (isObject(a) && isObject(b)) {
		const aIsArray = Array.isArray(a);
		const bIsArray = Array.isArray(b);

		if (aIsArray !== bIsArray) return false;

		if (aIsArray && bIsArray) {
			if (a.length !== b.length) return false;
			for (let i = 0; i < a.length; i++) {
				if (!deepEqual(a[i], b[i])) return false;
			}
			return true;
		}

		// Object comparison
		const keysA = Object.keys(a).sort();
		const keysB = Object.keys(b).sort();

		if (keysA.length !== keysB.length) return false;

		for (let i = 0; i < keysA.length; i++) {
			if (
				keysA[i] !== keysB[i] ||
				!deepEqual((a as any)[keysA[i]], (b as any)[keysB[i]])
			) {
				return false;
			}
		}
		return true;
	}

	return false;
}

/**
 * Safely parse JSON without throwing. Returns the provided fallback on failure.
 */
export function safeParse<T>(raw: string, fallback: T | null = null): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/**
 * Checks if a value is non-null, a non-empty string, or a non-empty array.
 * This is a generic "presence" check for data processing.
 */
export function hasValue(v: unknown): boolean {
	if (v === undefined || v === null) return false;
	if (typeof v === "string" && v.trim() === "") return false;
	if (Array.isArray(v) && v.length === 0) return false;
	return true;
}

/**
 * Type guard to check if a value is a plain object (not null, not array).
 * @param obj The value to check.
 * @returns True if the value is an object, false otherwise.
 */
function isObject(obj: unknown): obj is object {
	return typeof obj === "object" && obj !== null;
}
