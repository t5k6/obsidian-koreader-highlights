import { SimpleCache } from "src/lib/cache";
import { err, ok, type Result } from "src/lib/core/result";
import type { ParseFailure } from "../errors/types";

const MASK_CACHE = new SimpleCache<string, (d: Date) => string>(64);

function compileMask(mask: string): (date: Date) => string {
	return (date) =>
		mask
			.replace(/\{YYYY\}/g, String(date.getFullYear()))
			.replace(/\{MM\}/g, String(date.getMonth() + 1).padStart(2, "0"))
			.replace(/\{DD\}/g, String(date.getDate()).padStart(2, "0"));
}

function isValidCustomFormat(format: string): boolean {
	const tokenRegex = /\{([^}]+)\}/g;
	let match = tokenRegex.exec(format);
	while (match !== null) {
		const token = match[1];
		if (token !== "YYYY" && token !== "MM" && token !== "DD") return false;
		match = tokenRegex.exec(format);
	}
	return true;
}

/**
 * A centralized, safe date formatter using toLocaleDateString.
 * @param date The Date object to format.
 * @param locale The locale string (e.g., "en-US") or undefined for system locale.
 * @returns Result with formatted date string, or a DateParseError on error.
 */
function toLocaleDateSafe(
	date: Date,
	locale: string | undefined,
): Result<string, ParseFailure> {
	try {
		if (Number.isNaN(date.getTime())) {
			return err({ kind: "DateParseError", input: String(date) });
		}
		const s = date.toLocaleDateString(locale, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
		return ok(s);
	} catch {
		return err({ kind: "DateParseError", input: String(date) });
	}
}

function _coerceToDate(input: string | number | Date): Date {
	if (input instanceof Date) return input;
	if (typeof input === "number") return new Date(input);
	return new Date(input);
}

/**
 * Primary date formatter.
 * - No format: stable en-US short date (existing behavior)
 * - format = 'locale': user's system locale
 * - format = 'daily-note': [[YYYY-MM-DD]]
 * - format = custom mask supporting tokens YYYY, MM, DD
 */
export function formatDate(
	dateInput: string | number | Date,
	format?: "locale" | "daily-note" | string,
): string {
	const date = _coerceToDate(dateInput);
	if (Number.isNaN(date.getTime())) {
		return "";
	}

	if (!format) {
		// Backward-compatible default: en-US
		const r = toLocaleDateSafe(date, "en-US");
		return r.ok ? r.value : "";
	}

	if (format === "locale") {
		const r = toLocaleDateSafe(date, undefined);
		return r.ok ? r.value : "";
	}

	if (format === "daily-note") {
		const y = String(date.getFullYear());
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		return `[[${y}-${m}-${d}]]`;
	}

	// Custom mask
	if (!isValidCustomFormat(format)) {
		return "";
	}
	let fn = MASK_CACHE.get(format);
	if (!fn) {
		fn = compileMask(format);
		MASK_CACHE.set(format, fn);
	}
	return fn(date);
}

/**
 * Pure variant that returns a Result for callers that want structured errors.
 */
export function formatDateResult(
	dateInput: string | number | Date,
	format?: "locale" | "daily-note" | string,
): Result<string, ParseFailure> {
	const date = _coerceToDate(dateInput);
	if (Number.isNaN(date.getTime())) {
		return err({ kind: "DateParseError", input: String(dateInput) });
	}

	if (!format) {
		return toLocaleDateSafe(date, "en-US");
	}
	if (format === "locale") {
		return toLocaleDateSafe(date, undefined);
	}
	if (format === "daily-note") {
		const y = String(date.getFullYear());
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");
		return ok(`[[${y}-${m}-${d}]]`);
	}
	if (format !== "locale" && format !== "daily-note") {
		if (!isValidCustomFormat(format)) {
			return err({ kind: "DateParseError", input: format });
		}
		let fn = MASK_CACHE.get(format);
		if (!fn) {
			fn = compileMask(format);
			MASK_CACHE.set(format, fn);
		}
		return ok(fn(date));
	}
	return err({ kind: "DateParseError", input: format });
}

/**
 * Returns current date (or provided date) in YYYY-MM-DD format for daily notes/filenames.
 * @param date Optional Date (defaults to now)
 */
export function formatDateForDailyNote(date: Date = new Date()): string {
	// ISO 8601 date prefix, stable and timezone-safe for filenames
	return date.toISOString().slice(0, 10);
}

/**
 * Returns a detailed, filesystem-safe timestamp (e.g., 2025-08-19T05-37-12-345Z).
 * Useful for versioned filenames and logs.
 * @param date Optional Date (defaults to now)
 */
export function formatDateForTimestamp(date: Date = new Date()): string {
	// Format: YYYY-MM-DDTHH-mm-ss-sssZ (filesystem-safe, derived from ISO 8601)
	// We replace colon and dot which are problematic on some filesystems.
	return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Formats a Unix timestamp to readable date.
 * @param timestamp - Unix timestamp (seconds since epoch)
 * @returns Formatted date like "Jan 1, 2025"
 */
export function formatUnixTimestamp(timestamp: number): string {
	const r = toLocaleDateSafe(new Date(timestamp * 1000), "en-US");
	return r.ok ? r.value : "";
}

/**
 * Converts seconds to human-readable time format.
 * @param totalSeconds - Number of seconds to convert
 * @returns Formatted string like "2h 30m 45s" or "45s"
 */
export function secondsToHoursMinutesSeconds(totalSeconds: number): string {
	if (totalSeconds < 0) totalSeconds = 0;

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);

	let result = "";
	if (hours > 0) {
		result += `${hours}h `;
	}
	if (minutes > 0 || hours > 0) {
		result += `${minutes}m `;
	}
	if (seconds > 0 || result === "") {
		result += `${seconds}s`;
	}

	result = result.trim();

	return result === "" ? "0s" : result;
}

/**
 * Formats a duration in seconds as a compact "Xh Ym Zs" style string.
 * Rules:
 * - No leading 0h.
 * - No trailing 0s when hours or minutes are present.
 * - If only seconds exist, show "Xs".
 * - If everything is zero, show "0s".
 */
export function formatDurationHms(totalSeconds: number): string {
	if (totalSeconds < 0) totalSeconds = 0;

	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);

	const parts: string[] = [];

	if (hours > 0) {
		parts.push(`${hours}h`);
	}
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	if (seconds > 0 || parts.length === 0) {
		// Include seconds if non-zero, or if there are no hours/minutes (pure seconds/zero case)
		parts.push(`${seconds}s`);
	}

	return parts.join(" ");
}

/**
 * Formats a short duration in seconds as:
 * - "Xs" if < 60 seconds
 * - "Xm Ys" if ≥ 60 seconds
 */
export function formatShortDuration(totalSeconds: number): string {
	if (totalSeconds < 0) totalSeconds = 0;

	const sec = Math.floor(totalSeconds);
	if (sec < 60) {
		return `${sec}s`;
	}

	const minutes = Math.floor(sec / 60);
	const seconds = sec % 60;

	if (seconds === 0) {
		return `${minutes}m`;
	}

	return `${minutes}m ${seconds}s`;
}

/**
 * Converts seconds to hours and minutes format.
 * @param seconds - Number of seconds to convert
 * @returns Formatted string like "2h 30m"
 */
export function secondsToHoursMinutes(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${minutes}m`;
}
