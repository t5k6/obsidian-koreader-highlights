import type { Database, SqlValue } from "sql.js";
import { throwIfAborted } from "src/lib/concurrency/cancellation";
import type {
	BookStatistics,
	BookStatisticsBundle,
	PageStatData,
	ReadingProgress,
	ReadingStatus,
} from "src/types";

// Constants (inline or export if reused)
const BOOK_COLUMNS =
	"id, md5, last_open, pages, total_read_time, total_read_pages, title, authors, series, language";
const SQL_FIND_BOOK_BY_MD5 = `SELECT ${BOOK_COLUMNS} FROM book WHERE md5 = ? AND title = ?`;
const SQL_FIND_BOOK_BY_AUTHOR_TITLE = `SELECT ${BOOK_COLUMNS} FROM book WHERE authors = ? AND title = ?`;
const SQL_GET_SESSIONS = `SELECT * FROM page_stat_data WHERE id_book = ? ORDER BY start_time`;

/**
 * Generic query for first row.
 */
export function queryFirstRow<T extends object>(
	db: Database,
	sql: string,
	params: SqlValue[] = [],
): T | null {
	const stmt = db.prepare(sql);
	try {
		stmt.bind(params);
		return stmt.step() ? (stmt.getAsObject() as T) : null;
	} finally {
		stmt.free();
	}
}

/**
 * Generic query for all rows.
 */
export function queryAllRows<T extends object>(
	db: Database,
	sql: string,
	params: SqlValue[] = [],
): T[] {
	const out: T[] = [];
	const stmt = db.prepare(sql);
	try {
		stmt.bind(params);
		while (stmt.step()) out.push(stmt.getAsObject() as T);
		return out;
	} finally {
		stmt.free();
	}
}

/**
 * Maps raw row to BookStatistics with validation.
 */
export function mapBookRow(raw: Record<string, unknown>): BookStatistics {
	const toNumber = (value: unknown): number => {
		const n =
			typeof value === "number"
				? value
				: typeof value === "string"
					? Number(value)
					: 0;
		return Number.isFinite(n) ? n : 0;
	};

	return {
		id: toNumber(raw.id),
		md5: String(raw.md5 ?? ""),
		last_open: toNumber(raw.last_open),
		pages: toNumber(raw.pages),
		total_read_pages: toNumber(raw.total_read_pages),
		total_read_time: toNumber(raw.total_read_time),
		title: String(raw.title ?? "Unknown Title"),
		authors: String(raw.authors ?? ""),
		series: typeof raw.series === "string" ? raw.series : undefined,
		language: typeof raw.language === "string" ? raw.language : undefined,
	};
}

/**
 * Calculates reading streak (consecutive days with reading activity).
 * Returns the current streak count (0 if no recent activity or streak broken).
 */
export function calculateReadingStreak(sessions: PageStatData[]): number {
	if (sessions.length === 0) return 0;

	// Helper to get local date string (YYYY-MM-DD) from timestamp
	const getLocalDateKey = (timestamp: number): string => {
		const date = new Date(timestamp * 1000);
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		return `${year}-${month}-${day}`;
	};

	// Get unique days (as YYYY-MM-DD strings) from sessions
	const readingDays = new Set<string>();
	for (const session of sessions) {
		const dayKey = getLocalDateKey(session.start_time);
		readingDays.add(dayKey);
	}

	// Convert to sorted array (most recent first)
	const uniqueDays = Array.from(readingDays).sort((a, b) => b.localeCompare(a));

	if (uniqueDays.length === 0) return 0;

	// Get today and yesterday in local time
	const now = new Date();
	const todayKey = getLocalDateKey(Math.floor(now.getTime() / 1000));

	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const yesterdayKey = getLocalDateKey(Math.floor(yesterday.getTime() / 1000));

	const mostRecentDay = uniqueDays[0];

	// Streak is broken if the most recent reading was more than 1 day ago
	if (mostRecentDay !== todayKey && mostRecentDay !== yesterdayKey) {
		return 0;
	}

	// Count consecutive days backwards from the most recent day
	let streak = 1;

	// Parse the most recent day to start counting backwards
	const [year, month, day] = mostRecentDay.split("-").map(Number);
	const currentDate = new Date(year, month - 1, day);

	for (let i = 1; i < uniqueDays.length; i++) {
		// Move back one day
		currentDate.setDate(currentDate.getDate() - 1);
		const expectedDay = getLocalDateKey(
			Math.floor(currentDate.getTime() / 1000),
		);

		if (uniqueDays[i] === expectedDay) {
			streak++;
		} else {
			// Streak is broken
			break;
		}
	}

	return streak;
}

/**
 * Session grouping threshold: if more than 30 minutes pass between page reads,
 * consider it a new reading session.
 */
const SESSION_GAP_THRESHOLD_SECONDS = 30 * 60; // 30 minutes

/**
 * Groups page reads into reading sessions based on time gaps.
 * A new session starts when the gap between consecutive page reads exceeds the threshold.
 */
export function groupPageReadsIntoSessions(
	pageReads: PageStatData[],
): Array<{ startTime: number; endTime: number; duration: number }> {
	if (pageReads.length === 0) return [];

	// Sort by start_time to ensure chronological order
	const sorted = [...pageReads].sort((a, b) => a.start_time - b.start_time);

	const sessions: Array<{
		startTime: number;
		endTime: number;
		duration: number;
	}> = [];

	let sessionStart = sorted[0].start_time;
	let sessionEnd = sorted[0].start_time + (sorted[0].duration || 0);

	for (let i = 1; i < sorted.length; i++) {
		const currentPageStart = sorted[i].start_time;
		const currentPageEnd = currentPageStart + (sorted[i].duration || 0);
		const gapFromPreviousPage = currentPageStart - sessionEnd;

		if (gapFromPreviousPage > SESSION_GAP_THRESHOLD_SECONDS) {
			// Gap is too large - finish current session and start a new one
			sessions.push({
				startTime: sessionStart,
				endTime: sessionEnd,
				duration: sessionEnd - sessionStart,
			});
			sessionStart = currentPageStart;
			sessionEnd = currentPageEnd;
		} else {
			// Continue current session
			sessionEnd = currentPageEnd;
		}
	}

	// Don't forget the last session
	sessions.push({
		startTime: sessionStart,
		endTime: sessionEnd,
		duration: sessionEnd - sessionStart,
	});

	return sessions;
}

/**
 * Calculates average reading session duration in seconds.
 * Groups page reads into sessions (gap > 30 min = new session), then averages session lengths.
 * Returns 0 if no sessions or invalid data.
 */
export function calculateAverageSessionDuration(
	pageReads: PageStatData[],
): number {
	const sessions = groupPageReadsIntoSessions(pageReads);
	if (sessions.length === 0) return 0;

	const totalDuration = sessions.reduce((sum, s) => sum + s.duration, 0);
	return Math.round(totalDuration / sessions.length);
}

/**
 * Calculates derived reading progress.
 */
export function calculateDerivedStatistics(
	book: BookStatistics,
	sessions: PageStatData[],
): ReadingProgress {
	const totalReadPages = book.total_read_pages;
	const totalReadTime = book.total_read_time;
	const pages = book.pages;
	const rawPercent = pages > 0 ? (totalReadPages / pages) * 100 : 0;

	const lastOpenSec = book.last_open;
	const lastOpenDate = lastOpenSec > 0 ? new Date(lastOpenSec * 1000) : null;

	const firstStartSec = sessions[0]?.start_time ?? 0;
	const firstReadDate =
		firstStartSec > 0 ? new Date(firstStartSec * 1000) : null;

	const lastReadDate =
		lastOpenDate && firstReadDate && lastOpenDate < firstReadDate
			? firstReadDate
			: (lastOpenDate ?? firstReadDate);

	const percentComplete = Math.max(0, Math.min(100, Math.round(rawPercent)));

	const readingStatus: ReadingStatus =
		percentComplete >= 100
			? "completed"
			: sessions.length === 0
				? "unstarted"
				: "ongoing";

	return {
		percentComplete,
		averageTimePerPage:
			percentComplete > 0 && totalReadTime > 0
				? Math.round(totalReadTime / (pages * (percentComplete / 100)))
				: 0,
		firstReadDate,
		lastReadDate,
		readingStatus,
		totalReadSeconds: totalReadTime,
		sessionCount: sessions.length,
		readingStreak: calculateReadingStreak(sessions),
		avgSessionDuration: calculateAverageSessionDuration(sessions),
	};
}

/**
 * Finds book by md5/title or author/title fallback.
 */
export function findBook(
	db: Database,
	title: string,
	authors: string,
	md5?: string,
	signal?: AbortSignal,
): BookStatistics | null {
	throwIfAborted(signal);
	let rawRow: Record<string, unknown> | null = null;
	if (md5) {
		rawRow = queryFirstRow(db, SQL_FIND_BOOK_BY_MD5, [md5, title]);
	}
	if (!rawRow) {
		rawRow = queryFirstRow(db, SQL_FIND_BOOK_BY_AUTHOR_TITLE, [authors, title]);
	}
	return rawRow ? mapBookRow(rawRow) : null;
}

/**
 * Gets reading sessions for book ID.
 */
export function getSessions(
	db: Database,
	bookId: number,
	signal?: AbortSignal,
): PageStatData[] {
	throwIfAborted(signal);
	return queryAllRows<PageStatData>(db, SQL_GET_SESSIONS, [bookId]);
}

/**
 * High-level: Gets full statistics bundle for a book.
 */
export function getBookStatisticsBundle(
	db: Database,
	title: string,
	authors: string,
	md5?: string,
	signal?: AbortSignal,
): BookStatisticsBundle | null {
	// Check signal before each step
	throwIfAborted(signal);
	const book = findBook(db, title, authors, md5, signal);
	if (!book) return null;
	throwIfAborted(signal);
	const sessions = getSessions(db, book.id, signal);
	const derived = calculateDerivedStatistics(book, sessions);
	return { book, readingSessions: sessions, derived };
}

/**
 * Get the count of books with a specific MD5.
 */
export function getMd5OccurrenceCount(db: Database, md5: string): number {
	const result = queryFirstRow<{ count: number }>(
		db,
		"SELECT COUNT(*) as count FROM book WHERE md5 = ?",
		[md5],
	);
	return result?.count ?? 0;
}

/**
 * Query books that match any of the given identifiers.
 * Identifiers are scheme:value pairs like "uuid:123", "isbn:456", etc.
 */
export function queryBooksByIdentifiers(
	db: Database,
	identifiers: Array<{ scheme: string; value: string }>,
): Array<{ id: number; md5: string; title: string; authors: string }> {
	if (identifiers.length === 0) return [];

	// Build a query that checks for any matching identifier in the book table
	// Note: KOReader doesn't store identifiers in the book table, so this is a placeholder
	// In practice, we'd need to extend the schema or find another way to match
	// For now, return empty array since we can't match on identifiers in the current schema
	return [];
}
