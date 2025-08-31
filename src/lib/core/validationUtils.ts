export function ensureBoolean(value: unknown, defaultValue: boolean): boolean {
	return typeof value === "boolean" ? value : defaultValue;
}

export function ensureNumber(value: unknown, defaultValue: number): number {
	return typeof value === "number" && !Number.isNaN(value)
		? value
		: defaultValue;
}

export function ensureNumberInRange(
	value: unknown,
	defaultValue: number,
	range: readonly number[],
): number {
	const num = ensureNumber(value, defaultValue);
	return range.includes(num) ? num : defaultValue;
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
 * Validates if a string matches the HMS (hours, minutes, seconds) format.
 * Example: "2h 30m 45s"
 */
export function isHms(s: unknown): boolean {
	return typeof s === "string" && /^\s*\d+h \d+m \d+s\s*$/.test(s);
}

/**
 * Validates if a string matches a percentage format.
 * Example: "50%" or "50.5%"
 */
export function isPercent(s: unknown): boolean {
	return typeof s === "string" && /^\s*\d+(\.\d+)?%\s*$/.test(s);
}

export const Validators = {
	isString: (v: unknown): v is string => typeof v === "string",
	isNumber: (v: unknown): v is number =>
		typeof v === "number" && !Number.isNaN(v),
	isBoolean: (v: unknown): v is boolean => typeof v === "boolean",
	isArray: <T>(
		v: unknown,
		itemValidator?: (item: unknown) => item is T,
	): v is T[] => Array.isArray(v) && (!itemValidator || v.every(itemValidator)),
	isRecord: (v: unknown): v is Record<string, unknown> =>
		!!v && typeof v === "object" && !Array.isArray(v),
	isNonEmptyString: (v: unknown): v is string =>
		typeof v === "string" && v.trim().length > 0,
	isPositiveNumber: (v: unknown): v is number =>
		typeof v === "number" && !Number.isNaN(v) && v > 0,
	isNonEmptyArray: <T>(
		v: unknown,
		itemValidator?: (item: unknown) => item is T,
	): v is T[] =>
		Array.isArray(v) &&
		v.length > 0 &&
		(!itemValidator || v.every(itemValidator)),
} as const;

export function validateAndExtract<T>(
	obj: unknown,
	key: string,
	validator: (v: unknown) => v is T,
	fallback: T,
): T {
	if (!Validators.isRecord(obj)) return fallback;
	const value = obj[key];
	return validator(value) ? value : fallback;
}
