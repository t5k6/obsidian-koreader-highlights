import * as fs from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import initSqlJs from "sql.js";
import { SQLITE_WASM } from "../binaries/sql-wasm-base64";
import type {
    BookStatistics,
    KoReaderHighlightImporterSettings,
    LuaMetadata,
    PageStatData,
    ReadingStatus,
} from "../types";
import { handleFileSystemError } from "../utils/fileUtils";
import { devError, devLog, devWarn } from "../utils/logging";

type SQLDatabase = InstanceType<
    Awaited<ReturnType<typeof initSqlJs>>["Database"]
>;

export class DatabaseService {
    private db: SQLDatabase | null = null;
    private dbPath: string | null = null;
    private currentMountPoint: string | null = null;

    constructor(private settings: KoReaderHighlightImporterSettings) {
        this.currentMountPoint = this.settings.koboMountPoint;
        this.updateDbPath();
    }

    private async findDeviceRoot(startPath: string): Promise<string | null> {
        let currentPath = path.resolve(startPath);

        for (let i = 0; i < 10; i++) { // Max 10 levels up
            try {
                // Check for a reliable KoReader/Kobo root indicator.
                const addsPath = path.join(currentPath, ".adds");
                await access(addsPath);

                devLog(
                    `Found potential device root at: ${currentPath} (contains .adds)`,
                );
                return currentPath;
            } catch (error) {
                // .adds not found or not accessible at currentPath, try parent
            }

            const parentPath = path.dirname(currentPath);
            if (parentPath === currentPath) {
                devWarn(
                    `Reached filesystem root without finding .adds directory starting from ${startPath}.`,
                );
                break;
            }
            currentPath = parentPath;
        }
        devWarn(
            `Could not determine KoReader device root by traversing up from ${startPath}.`,
        );
        return null; // Could not find a suitable root
    }

    private async updateDbPath(): Promise<void> {
        if (this.settings.koboMountPoint) {
            let deviceRoot: string | null = null;

            if (process.platform === "win32") {
                // On Windows, use the drive root (e.g., G:\) as the base for finding .adds
                const parsedPath = path.parse(this.settings.koboMountPoint);
                const driveRoot = parsedPath.root ||
                    this.settings.koboMountPoint; // e.g., C:\
                // We still need to confirm .adds is on this driveRoot for KoReader
                deviceRoot = await this.findDeviceRoot(driveRoot);
                if (!deviceRoot) {
                    // Fallback if findDeviceRoot fails even on Windows drive root
                    devWarn(
                        `Could not confirm .adds on Windows drive root ${driveRoot}. Using configured mount point as a fallback for DB path construction.`,
                    );
                    deviceRoot = this.settings.koboMountPoint; // Less ideal fallback
                }
            } else {
                // On POSIX (Linux, macOS), try to find the root by traversing upwards
                // from the configured koboMountPoint.
                deviceRoot = await this.findDeviceRoot(
                    this.settings.koboMountPoint,
                );
                if (!deviceRoot) {
                    devWarn(
                        `Could not find KoReader device root from ${this.settings.koboMountPoint}. Using configured mount point as a fallback for DB path construction.`,
                    );
                    // Fallback to using the configured mount point directly if root finding fails.
                    deviceRoot = this.settings.koboMountPoint;
                }
            }

            if (deviceRoot) {
                this.dbPath = path.join(
                    deviceRoot,
                    ".adds",
                    "koreader",
                    "settings",
                    "statistics.sqlite3",
                );
                devLog(`Database path set to: ${this.dbPath}`);
            } else {
                this.dbPath = null;
                devError(
                    "Failed to determine a valid device root for the database path.",
                );
            }
        } else {
            this.dbPath = null;
            devWarn(
                "Database path cannot be determined: KoReader mount point not set.",
            );
        }
    }

    private async initializeDatabase(): Promise<void> {
        if (this.settings.koboMountPoint !== this.currentMountPoint) {
            devLog("Mount point setting changed, re-evaluating database path.");
            this.closeDatabase();
            this.currentMountPoint = this.settings.koboMountPoint;
            await this.updateDbPath();
        } else if (!this.dbPath && this.settings.koboMountPoint) {
            devLog("Database path not set, attempting to update it.");
            await this.updateDbPath();
        }

        if (!this.dbPath) {
            throw new Error("Database path is not configured.");
        }

        if (this.db) {
            try {
                this.db.exec("SELECT 1");
                return;
            } catch (e) {
                devWarn(
                    "Database connection lost or closed, reinitializing...",
                );
                this.db = null;
            }
        }

        devLog(`Initializing database from: ${this.dbPath}`);
        try {
            const binary = Buffer.from(SQLITE_WASM, "base64");
            const SQL = await initSqlJs({
                wasmBinary: binary as Uint8Array,
            });

            if (!fs.existsSync(this.dbPath)) {
                throw new Error(
                    `Database file not found at path: ${this.dbPath}`,
                );
            }

            const fileBuffer = fs.readFileSync(this.dbPath);
            this.db = new SQL.Database(fileBuffer);
            devLog("Database connection successful");

            this.db.exec("SELECT 1");
            devLog("Database test query successful");
        } catch (error) {
            handleFileSystemError(
                "initializing database (reading file)",
                this.dbPath || "Unknown DB Path",
                error,
                { shouldThrow: true },
            );
            const err = error as Error;
            this.db = null;
            devError(
                "Failed to initialize the database:",
                err.message,
                err.stack,
            );
            throw new Error(`Database initialization failed: ${err.message}`);
        }
    }

    async getBookStatistics(
        authors: string,
        title: string,
    ): Promise<LuaMetadata["statistics"] | null> {
        if (!this.dbPath) {
            devWarn("Skipping statistics fetch: Database path not configured.");
            return null;
        }

        try {
            await this.initializeDatabase();

            if (!this.db) {
                devError(
                    "Database is not initialized after initialization attempt.",
                );
                return null;
            }

            devLog(
                `Querying statistics for: Author="${authors}", Title="${title}"`,
            );
            const bookQuery = this.db.prepare(
                "SELECT * FROM book WHERE authors = ? AND title = ?",
            );
            bookQuery.bind([authors, title]);

            let bookResult: BookStatistics | null = null;
            if (bookQuery.step()) {
                bookResult = bookQuery
                    .getAsObject() as unknown as BookStatistics;
            }
            bookQuery.free();

            if (!bookResult || Object.keys(bookResult).length === 0) {
                devLog(`No book entry found for: ${authors} - ${title}`);
                return null; // No matching book found
            }

            devLog(
                `Found book entry (ID: ${bookResult.id}), fetching reading sessions...`,
            );
            const sessionsQuery = this.db.prepare(
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

            devLog(`Found ${sessions.length} reading sessions.`);

            return {
                book: bookResult,
                readingSessions: sessions,
                derived: this.calculateDerivedStatistics(bookResult, sessions),
            };
        } catch (error) {
            const err = error as Error;
            devError(
                `Failed to fetch book statistics for "${title}":`,
                err.message,
                err.stack,
            );
            return null;
        }
    }

    private calculateDerivedStatistics(
        book: BookStatistics,
        sessions: PageStatData[],
    ) {
        const totalReadPages = book.total_read_pages ?? 0;
        const bookPages = book.pages ?? 0;

        // Ensure pages is not zero to avoid division by zero
        const percentComplete = (bookPages > 0 && totalReadPages > 0)
            ? Math.round((totalReadPages / bookPages) * 100)
            : 0;

        // Ensure total_read_pages is not zero
        const averageTimePerPage =
            (totalReadPages > 0 && book.total_read_time > 0)
                ? book.total_read_time / 60 / totalReadPages // Avg time in minutes per page
                : 0;

        const readingStatus: ReadingStatus = sessions.length === 0
            ? "unstarted"
            : (bookPages > 0 && totalReadPages >= bookPages)
            ? "completed"
            : "ongoing";

        return {
            percentComplete: percentComplete,
            averageTimePerPage: averageTimePerPage,
            firstReadDate: sessions.length > 0
                ? new Date(sessions[0].start_time * 1000)
                : null,
            lastReadDate: new Date(book.last_open * 1000),
            readingStatus: readingStatus,
        };
    }

    public async updateSettings(
        newSettings: KoReaderHighlightImporterSettings,
    ): Promise<void> {
        const oldMountPoint = this.settings.koboMountPoint;
        this.settings = newSettings;

        if (this.settings.koboMountPoint !== oldMountPoint) {
            devLog(
                "Mount point setting potentially changed in updateSettings, re-evaluating database path...",
            );
            this.closeDatabase();
            this.currentMountPoint = this.settings.koboMountPoint;
            await this.updateDbPath();
        }
    }

    closeDatabase(): void {
        if (this.db) {
            try {
                this.db.close();
                this.db = null;
                devLog("Database connection closed successfully.");
            } catch (error) {
                devError("Error closing database connection:", error);
            }
        }
    }
}
