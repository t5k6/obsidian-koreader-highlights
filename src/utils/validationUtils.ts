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
	range: (number | undefined)[],
): number {
	const num = ensureNumber(value, defaultValue);
	return range.includes(num) ? num : defaultValue;
}

export function ensureStringArray(
	value: unknown,
	defaultValue: string[],
): string[] {
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
		return value.map((s) => s.trim()).filter(Boolean);
	}
	return defaultValue;
}
