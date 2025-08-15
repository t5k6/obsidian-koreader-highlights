import type { LoggingService } from "src/services/LoggingService";

/**
 * A centralized, safe date formatter using toLocaleDateString.
 * @param date The Date object to format.
 * @param locale The locale string (e.g., "en-US") or undefined for system locale.
 * @param logger Optional logging service for error reporting.
 * @returns A formatted date string or an empty string on error.
 */
function _toLocaleDate(
	date: Date,
	locale: string | undefined,
	logger?: LoggingService,
): string {
	try {
		if (Number.isNaN(date.getTime())) {
			throw new Error("Invalid date object");
		}
		return date.toLocaleDateString(locale, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	} catch (e) {
		logger?.warn("dateUtils:Date", `Could not format date "${date}"`, e);
		return "";
	}
}

/**
 * Formats a date string to US English format.
 * @param dateStr - ISO date string
 * @returns Formatted date like "Jan 1, 2025"
 */
export function formatDate(dateStr: string): string {
	return _toLocaleDate(new Date(dateStr), "en-US");
}

/**
 * Formats a given date string using a custom format string.
 *
 * Supported tokens:
 * - YYYY: Full year (e.g., 2025)
 * - MM:   Month with leading zero (01-12)
 * - DD:   Day with leading zero (01-31)
 *
 * @param dateStr The ISO-like date string to format.
 * @param format The format string.
 * @returns The formatted date string, or an empty string on error.
 */
export function formatDateWithFormat(
	dateStr: string,
	format: string,
	logger?: LoggingService,
): string {
	if (!dateStr || !format) return "";
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) {
			throw new Error("Invalid date");
		}
		return format
			.replace(/YYYY/g, String(date.getFullYear()))
			.replace(/MM/g, String(date.getMonth() + 1).padStart(2, "0"))
			.replace(/DD/g, String(date.getDate()).padStart(2, "0"));
	} catch (e) {
		logger?.warn(
			"dateUtils:Date",
			`Could not parse or format date "${dateStr}" with format "${format}"`,
			e,
		);
		return "";
	}
}

/**
 * Formats a date string according to the user's system locale settings.
 * @param dateStr The ISO-like date string.
 * @returns A locale-specific date string.
 */
export function formatDateLocale(
	dateStr: string,
	logger?: LoggingService,
): string {
	return _toLocaleDate(new Date(dateStr), undefined, logger);
}

/**
 * Creates a formatted Obsidian daily note link from a date string.
 * e.g., [[2025-07-22]]
 * @param dateStr The ISO-like date string.
 * @returns A string containing the Markdown link.
 */
export function formatDateAsDailyNote(dateStr: string): string {
	const formattedDate = formatDateWithFormat(dateStr, "YYYY-MM-DD");
	return formattedDate ? `[[${formattedDate}]]` : "";
}

/**
 * Formats a Unix timestamp to readable date.
 * @param timestamp - Unix timestamp (seconds since epoch)
 * @returns Formatted date like "Jan 1, 2025"
 */
export function formatUnixTimestamp(timestamp: number): string {
	return _toLocaleDate(new Date(timestamp * 1000), "en-US");
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
 * Converts seconds to hours and minutes format.
 * @param seconds - Number of seconds to convert
 * @returns Formatted string like "2h 30m"
 */
export function secondsToHoursMinutes(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${minutes}m`;
}
