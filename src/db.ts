import * as fs from "node:fs";
import initSqlJs from "sql.js";
import { SQLITE_WASM } from "./binaries/sql-wasm-base64";
import type { BookStatistics, LuaMetadata, PageStatData } from "./types";
import { devError, devLog } from "./utils";

// Define types for our SQL database and statements
type SQLDatabase = InstanceType<
    Awaited<ReturnType<typeof initSqlJs>>["Database"]
>;
type SQLStatement = ReturnType<SQLDatabase["prepare"]>;

// Hold the database instance so that it can be reused
let db: SQLDatabase | null = null;

/**
 * Initializes the SQL.js database from the provided database file path.
 * The WASM binary is provided as a direct binary buffer built from a base64 string.
 *
 * @param dbPath Absolute path to the database file.
 * @throws If the database file does not exist or initialization fails.
 */
async function initializeDatabase(dbPath: string): Promise<void> {
    try {
        // Convert the embedded base64 string to a binary Buffer.
        const binary = Buffer.from(SQLITE_WASM, "base64");

        // Initialize sql.js using the binary.
        // TypeScript doesn't officially support the `wasmBinary` property,
        // so we use a type assertion to bypass the error.
        const SQL = await initSqlJs({
            wasmBinary: binary as Uint8Array,
        });

        // Check if the database file exists.
        if (!fs.existsSync(dbPath)) {
            throw new Error(`Database file not found at path: ${dbPath}`);
        }

        // Read the database file as a Buffer.
        const fileBuffer = fs.readFileSync(dbPath);

        // Initialize the SQL database with the file buffer.
        db = new SQL.Database(fileBuffer);
        devLog("Database connection successful");

        // Test the database connection by executing a simple query.
        db.exec("SELECT 1");
        devLog("Database test query successful");
    } catch (error) {
        const err = error as Error;
        devError("Failed to connect to the database:", err.message);
        throw new Error(`Database initialization failed: ${err.message}`);
    }
}

/**
 * Fetches book statistics from the database for a given author and title.
 *
 * @param dbPath Path to the database file.
 * @param authors Author name.
 * @param title Book title.
 * @returns The book statistics data or null if no matching book is found.
 */
export async function getBookStatistics(
    dbPath: string,
    authors: string,
    title: string,
): Promise<LuaMetadata["statistics"] | null> {
    if (!db) {
        await initializeDatabase(dbPath);
        devLog("Database initialized");
    }
    if (!db) {
        throw new Error("Database not initialized");
    }

    try {
        devLog("Executing query for book statistics");
        const bookQuery = db.prepare(
            "SELECT * FROM book WHERE authors = ? AND title = ?",
        );
        bookQuery.bind([authors, title]);

        if (!bookQuery.step()) {
            devLog(`No book found for: ${authors} - ${title}`);
            bookQuery.free();
            return null;
        }

        const rawBookResult = bookQuery.getAsObject();
        const bookResult = rawBookResult as unknown as BookStatistics;
        bookQuery.free();

        if (!bookResult || Object.keys(bookResult).length === 0) {
            devLog(`No book found for: ${authors} - ${title}`);
            return null;
        }

        devLog("Executing query for reading sessions");
        const sessionsQuery = db.prepare(
            "SELECT * FROM page_stat_data WHERE id_book = ? ORDER BY start_time",
        );
        sessionsQuery.bind([bookResult.id]);

        const sessions: PageStatData[] = [];
        while (sessionsQuery.step()) {
            sessions.push(
                sessionsQuery.getAsObject() as unknown as PageStatData,
            );
        }
        sessionsQuery.free();

        return {
            book: bookResult,
            readingSessions: sessions,
            derived: calculateDerivedStatistics(bookResult, sessions),
        };
    } catch (error) {
        const err = error as Error;
        devError("Failed to fetch book statistics:", err.message, err);
        throw new Error(`Failed to fetch book statistics: ${err.message}`);
    }
}

/**
 * Determines the reading status based on the total pages read and sessions.
 *
 * @param book The book statistics.
 * @param sessions Array of reading session data.
 * @returns One of "ongoing", "completed", or "unstarted".
 */
export function determineReadingStatus(
    book: BookStatistics,
    sessions: PageStatData[],
): "ongoing" | "completed" | "unstarted" {
    return sessions.length === 0
        ? "unstarted"
        : book.total_read_pages >= book.pages
        ? "completed"
        : "ongoing";
}

/**
 * Closes the database connection if it is open.
 */
export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
        devLog("Database connection closed");
    }
}

function calculateDerivedStatistics(
    book: BookStatistics,
    sessions: PageStatData[],
) {
    return {
        percentComplete: book.total_read_pages > 0
            ? Math.round((book.total_read_pages / book.pages) * 100)
            : 0,
        averageTimePerPage: book.total_read_pages > 0
            ? book.total_read_time / 60 / book.total_read_pages
            : 0,
        firstReadDate: sessions.length > 0
            ? new Date(sessions[0].start_time * 1000)
            : null,
        lastReadDate: new Date(book.last_open * 1000),
        readingStatus: determineReadingStatus(book, sessions),
    };
}
