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
			totalReadPages > 0 && totalReadTime > 0
				? totalReadTime / totalReadPages
				: 0,
		firstReadDate,
		lastReadDate,
		readingStatus,
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
