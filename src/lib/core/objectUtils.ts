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
