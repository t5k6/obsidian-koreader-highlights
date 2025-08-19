export function ensureString(value: unknown, defaultValue: string): string {
	return typeof value === "string" ? value : defaultValue;
}

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

export function ensureStringArray(
	value: unknown,
	defaultValue: readonly string[],
): string[] {
	if (
		Array.isArray(value) &&
		value.every((item): item is string => typeof item === "string")
	) {
		return value.map((s) => s.trim()).filter((s) => s.length > 0);
	}
	return [...defaultValue];
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
