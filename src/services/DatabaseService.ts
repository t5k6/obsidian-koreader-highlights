import * as fs from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { SQLITE_WASM } from "../binaries/sql-wasm-base64";
import type {
	BookStatistics,
	KoreaderHighlightImporterSettings,
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
	private initializing: Promise<void> | null = null;
	private static sqlJsInstance: SqlJsStatic | null = null;
	private static sqlJsInit: Promise<SqlJsStatic> | null = null;
	private get dbPath(): string | null {
		if (!this.settings.koboMountPoint) return null;
		return path.join(
			this.settings.koboMountPoint,
			".adds",
			"koreader",
			"settings",
			"statistics.sqlite3",
		);
	}

	constructor(private settings: KoreaderHighlightImporterSettings) {}

	private async findDeviceRoot(startPath: string): Promise<string | null> {
		let currentPath = path.resolve(startPath);

		for (let i = 0; i < 10; i++) {
			// Max 10 levels up
			try {
				// Check for a reliable KOReader/Kobo root indicator.
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
			`Could not determine KOReader device root by traversing up from ${startPath}.`,
		);
		return null; // Could not find a suitable root
	}

	/** Lazily load + cache sql.js, guarding against double-initialisation. */
	private static async getSqlJs(): Promise<SqlJsStatic> {
		if (DatabaseService.sqlJsInstance) return DatabaseService.sqlJsInstance;

		// If a previous call is already inflight, await it.
		if (DatabaseService.sqlJsInit) return DatabaseService.sqlJsInit;

		// First caller: start initialisation and remember the promise.
		const binary = Buffer.from(SQLITE_WASM, "base64");
		DatabaseService.sqlJsInit = initSqlJs({
			wasmBinary: binary as Uint8Array,
		})
			.then((instance) => {
				DatabaseService.sqlJsInstance = instance;
				DatabaseService.sqlJsInit = null; // clear to free memory
				return instance;
			})
			.catch((err) => {
				// Reset so that a later call can retry after an error
				DatabaseService.sqlJsInit = null;
				throw err;
			});

		return DatabaseService.sqlJsInit;
	}

	private async openDatabase(): Promise<void> {
		if (this.db) {
			try {
				this.db.exec("SELECT 1");
				return;
			} catch {
				devWarn("Database connection lost, reopening …");
				this.closeDatabase();
			}
		}

		if (!this.settings.koboMountPoint) {
			throw new Error("KOReader mount point is not configured.");
		}

		let deviceRoot: string | null;
		if (process.platform === "win32") {
			const driveRoot =
				path.parse(this.settings.koboMountPoint).root ||
				this.settings.koboMountPoint;
			deviceRoot =
				(await this.findDeviceRoot(driveRoot)) ?? this.settings.koboMountPoint;
		} else {
			deviceRoot =
				(await this.findDeviceRoot(this.settings.koboMountPoint)) ??
				this.settings.koboMountPoint;
		}

		const dbFilePath = path.join(
			deviceRoot,
			".adds",
			"koreader",
			"settings",
			"statistics.sqlite3",
		);
		devLog(`Opening statistics database at: ${dbFilePath}`);

		try {
			const SQL = await DatabaseService.getSqlJs();
			const fileBuffer = fs.readFileSync(dbFilePath);
			this.db = new SQL.Database(fileBuffer);
			this.db.exec("SELECT 1");
			devLog("Database connection established.");
		} catch (error) {
			handleFileSystemError("opening database", dbFilePath, error, {
				shouldThrow: true,
			});
			this.db = null;
			throw error;
		}
	}

	async getBookStatistics(
		authors: string,
		title: string,
	): Promise<LuaMetadata["statistics"] | null> {
		if (!this.settings.koboMountPoint) {
			devWarn(
				"Skipping statistics fetch: KOReader mount point not configured.",
			);
			return null;
		}

		await this.ensureReady();

		if (!this.db) {
			devError("Database is not initialized after initialization attempt.");
			return null;
		}

		devLog(`Querying statistics for: Author="${authors}", Title="${title}"`);
		const bookQuery = this.db.prepare(
			"SELECT * FROM book WHERE authors = ? AND title = ?",
		);
		bookQuery.bind([authors, title]);

		let bookResult: BookStatistics | null = null;
		if (bookQuery.step()) {
			bookResult = bookQuery.getAsObject() as unknown as BookStatistics;
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
			sessions.push(sessionsQuery.getAsObject() as unknown as PageStatData);
		}
		sessionsQuery.free();

		devLog(`Found ${sessions.length} reading sessions.`);

		return {
			book: bookResult,
			readingSessions: sessions,
			derived: this.calculateDerivedStatistics(bookResult, sessions),
		};
	}

	private calculateDerivedStatistics(
		book: BookStatistics,
		sessions: PageStatData[],
	) {
		const totalReadPages = book.total_read_pages ?? 0;
		const bookPages = book.pages ?? 0;

		// Ensure pages is not zero to avoid division by zero
		const percentComplete =
			bookPages > 0 && totalReadPages > 0
				? Math.round((totalReadPages / bookPages) * 100)
				: 0;

		// Ensure total_read_pages is not zero
		const averageTimePerPage =
			totalReadPages > 0 && book.total_read_time > 0
				? book.total_read_time / 60 / totalReadPages // Avg time in minutes per page
				: 0;

		const readingStatus: ReadingStatus =
			sessions.length === 0
				? "unstarted"
				: bookPages > 0 && totalReadPages >= bookPages
					? "completed"
					: "ongoing";

		return {
			percentComplete: percentComplete,
			averageTimePerPage: averageTimePerPage,
			firstReadDate:
				sessions.length > 0 ? new Date(sessions[0].start_time * 1000) : null,
			lastReadDate: new Date(book.last_open * 1000),
			readingStatus: readingStatus,
		};
	}

	public setSettings(newSettings: Readonly<KoreaderHighlightImporterSettings>) {
		if (newSettings.koboMountPoint !== this.settings.koboMountPoint) {
			this.closeDatabase(); // Invalidate connection
		}
		this.settings = { ...newSettings }; // Store a copy
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

	private async ensureReady(): Promise<void> {
		if (this.db) return;
		if (this.initializing) return this.initializing;

		this.initializing = (async () => {
			await this.openDatabase();
			this.initializing = null;
		})();

		return this.initializing;
	}
}
