function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Pure, typed deep merge for objects. Arrays are shallow-copied (replaced, not merged).
 * @param base The base object.
 * @param next The partial object to merge over the base.
 * @returns A new, deeply merged object of type T.
 */
export function deepMerge<T extends Record<string, any>>(
	base: T,
	next: Partial<T>,
): T {
	const out: Record<string, unknown> = { ...base };

	for (const [key, value] of Object.entries(next)) {
		if (value === undefined) continue;

		const baseValue = (base as Record<string, unknown>)[key];
		if (isPlainObject(value) && isPlainObject(baseValue)) {
			out[key] = deepMerge(baseValue as Record<string, unknown>, value);
		} else {
			out[key] = value;
		}
	}
	return out as T;
}
