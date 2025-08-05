import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { SQLITE_WASM } from "src/binaries/sql-wasm-base64";
import type { Disposable } from "src/types";
import type { FileSystemService } from "./FileSystemService";
import type { LoggingService } from "./LoggingService";

export interface OpenDbOptions {
	schemaSql?: string; // Run when a new file is created
	validate?: boolean; // Run PRAGMA quick_check
}

export class SqlJsManager implements Disposable {
	private readonly SCOPE = "SqlJsManager";
	private sqlJsInstance: SqlJsStatic | null = null;
	private sqlJsInit: Promise<SqlJsStatic> | null = null;
	private dbCache = new Map<string, Database>();
	private dbIsDirty = new Map<string, boolean>();

	constructor(
		private loggingService: LoggingService,
		private fsService: FileSystemService,
	) {}

	public async getSqlJs(): Promise<SqlJsStatic> {
		if (this.sqlJsInstance) return this.sqlJsInstance;
		if (this.sqlJsInit) return this.sqlJsInit;

		this.loggingService.info(this.SCOPE, "Initializing sql.js WASM...");
		const nodeBuffer = Buffer.from(SQLITE_WASM, "base64");
		const wasmBinary = nodeBuffer.buffer.slice(
			nodeBuffer.byteOffset,
			nodeBuffer.byteOffset + nodeBuffer.byteLength,
		);

		this.sqlJsInit = initSqlJs({ wasmBinary })
			.then((sql) => {
				this.loggingService.info(this.SCOPE, "sql.js WASM initialized.");
				this.sqlJsInstance = sql;
				this.sqlJsInit = null;
				return sql;
			})
			.catch((err) => {
				this.loggingService.error(
					this.SCOPE,
					"Failed to initialize sql.js WASM.",
					err,
				);
				this.sqlJsInit = null;
				throw err;
			});
		return this.sqlJsInit;
	}

	public async openDatabase(
		filePath: string,
		options: OpenDbOptions = {},
	): Promise<Database> {
		if (this.dbCache.has(filePath)) {
			return this.dbCache.get(filePath)!;
		}

		this.loggingService.info(this.SCOPE, `Opening database: ${filePath}`);
		const SQL = await this.getSqlJs();
		let bytes: Uint8Array | null = null;

		// Since the index path is now always absolute, this check is less critical
		// but it's good practice to keep it for flexibility.
		const isSystemPath = path.isAbsolute(filePath);

		try {
			const buffer = isSystemPath
				? await this.fsService.readNodeFile(filePath, true)
				: await this.fsService.readVaultBinary(filePath);
			bytes = new Uint8Array(buffer);
		} catch (e: any) {
			if (e.code === "ENOENT") {
				// This is the expected "file not found" on first run. Log it and continue.
				this.loggingService.info(
					this.SCOPE,
					`No database file found at ${filePath}, creating new.`,
				);
			} else {
				// Any other error is unexpected and should be thrown.
				this.loggingService.error(
					this.SCOPE,
					`Unexpected error reading database file: ${filePath}`,
					e,
				);
				throw e;
			}
		}

		// This logic is now guaranteed to execute correctly on first run.
		const db = bytes ? new SQL.Database(bytes) : new SQL.Database();

		if (!bytes && options.schemaSql) {
			this.loggingService.info(
				this.SCOPE,
				`Applying schema to new DB: ${filePath}`,
			);
			db.run(options.schemaSql);
			this.setDirty(filePath, true);
		}

		if (options.validate && bytes) {
			try {
				db.exec("PRAGMA quick_check;");
			} catch (e) {
				this.loggingService.error(
					this.SCOPE,
					`Database validation failed for ${filePath}. It may be corrupt.`,
					e,
				);
				throw e;
			}
		}

		try {
			db.exec("PRAGMA journal_mode = WAL;");
		} catch (_) {
			// ignore – most likely "cannot use WAL mode on an in-memory db"
		}

		db.exec("PRAGMA foreign_keys = ON;");
		this.dbCache.set(filePath, db);
		return db;
	}

	public async persistDatabase(filePath: string): Promise<void> {
		const db = this.dbCache.get(filePath);
		if (!db || !this.dbIsDirty.get(filePath)) {
			return;
		}

		this.loggingService.info(
			this.SCOPE,
			`Persisting database to disk: ${filePath}`,
		);
		try {
			const data = db.export();
			const buffer = data.buffer.slice(
				data.byteOffset,
				data.byteOffset + data.length,
			);
			const isSystemPath = path.isAbsolute(filePath);

			if (isSystemPath) {
				await this.fsService.writeNodeFile(filePath, new Uint8Array(buffer));
			} else {
				await this.fsService.writeVaultBinary(filePath, buffer);
			}

			this.setDirty(filePath, false);
		} catch (e) {
			this.loggingService.error(
				this.SCOPE,
				`Failed to persist database: ${filePath}`,
				e,
			);
		}
	}

	public async createInMemoryDatabase(): Promise<Database> {
		const SQL = await this.getSqlJs();
		this.loggingService.info(this.SCOPE, "Creating in-memory index database");
		const db = new SQL.Database();
		// Pragmas suitable for in-memory DB
		db.exec("PRAGMA foreign_keys = ON;");
		db.exec("PRAGMA synchronous = OFF;");
		return db;
	}

	public applySchema(db: Database, schemaSql: string): void {
		db.exec(schemaSql);
	}

	public closeDatabase(filePath: string): void {
		const db = this.dbCache.get(filePath);
		if (db) {
			this.loggingService.info(this.SCOPE, `Closing database: ${filePath}`);
			db.close();
			this.dbCache.delete(filePath);
			this.dbIsDirty.delete(filePath);
		}
	}

	public setDirty(filePath: string, isDirty: boolean): void {
		if (this.dbCache.has(filePath)) {
			this.dbIsDirty.set(filePath, isDirty);
		}
	}

	async dispose(): Promise<void> {
		this.loggingService.info(this.SCOPE, "Disposing all managed databases...");
		const persistPromises: Promise<void>[] = [];
		for (const filePath of this.dbCache.keys()) {
			if (this.dbIsDirty.get(filePath)) {
				persistPromises.push(this.persistDatabase(filePath));
			}
		}

		await Promise.all(persistPromises);

		for (const filePath of this.dbCache.keys()) {
			this.closeDatabase(filePath);
		}

		this.sqlJsInstance = null;
		this.sqlJsInit = null;
	}
}
