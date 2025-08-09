import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { SQLITE_WASM } from "src/binaries/sql-wasm-base64";
import type { Disposable } from "src/types";
import { AsyncLazy } from "src/utils/asyncLazy";
import type { FileSystemService } from "./FileSystemService";
import type { LoggingService } from "./LoggingService";

export interface OpenDbOptions {
	schemaSql?: string; // Run when a new file is created
	validate?: boolean; // Run PRAGMA quick_check
}

export class SqlJsManager implements Disposable {
	private readonly log;
	private sqlJsLazy: AsyncLazy<SqlJsStatic>;
	private dbCache = new Map<string, Database>();
	private dbIsDirty = new Map<string, boolean>();

	constructor(
		private loggingService: LoggingService,
		private fsService: FileSystemService,
	) {
		this.log = this.loggingService.scoped("SqlJsManager");
		this.sqlJsLazy = new AsyncLazy<SqlJsStatic>(async () => {
			this.log.info("Initializing sql.js WASM...");
			const nodeBuffer = Buffer.from(SQLITE_WASM, "base64");
			const wasmBinary = nodeBuffer.buffer.slice(
				nodeBuffer.byteOffset,
				nodeBuffer.byteOffset + nodeBuffer.byteLength,
			);
			const sql = await initSqlJs({ wasmBinary });
			this.log.info("sql.js WASM initialized.");
			return sql;
		});
	}

	public async getSqlJs(): Promise<SqlJsStatic> {
		return this.sqlJsLazy.get();
	}

	public async openDatabase(
		filePath: string,
		options: OpenDbOptions = {},
	): Promise<Database> {
		if (this.dbCache.has(filePath)) {
			return this.dbCache.get(filePath)!;
		}

		this.log.info(`Opening database: ${filePath}`);
		const SQL = await this.getSqlJs();
		let bytes: Uint8Array | null = null;

		try {
			const buffer = await this.fsService.readBinaryAuto(filePath);
			bytes = new Uint8Array(buffer);
		} catch (e: any) {
			if (e.code === "ENOENT") {
				// This is the expected "file not found" on first run. Log it and continue.
				this.log.info(`No database file found at ${filePath}, creating new.`);
			} else {
				// Any other error is unexpected and should be thrown.
				this.log.error(
					`Unexpected error reading database file: ${filePath}`,
					e,
				);
				throw e;
			}
		}
		const db = bytes ? new SQL.Database(bytes) : new SQL.Database();

		// Cache immediately so setDirty on a brand new DB marks it correctly
		this.dbCache.set(filePath, db);

		if (!bytes && options.schemaSql) {
			this.log.info(`Applying schema to new DB: ${filePath}`);
			db.run(options.schemaSql);
			this.setDirty(filePath, true);
		}

		if (options.validate && bytes) {
			try {
				db.exec("PRAGMA quick_check;");
			} catch (e: unknown) {
				this.log.error(
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
		return db;
	}

	public async persistDatabase(filePath: string): Promise<void> {
		const db = this.dbCache.get(filePath);
		if (!db || !this.dbIsDirty.get(filePath)) {
			return;
		}

		this.log.info(`Persisting database to disk: ${filePath}`);
		try {
			const data = db.export();
			// Ensure we pass a concrete ArrayBuffer (not ArrayBuffer | SharedArrayBuffer)
			// by copying the Uint8Array and using its backing buffer.
			const copy = data.slice();
			const buffer = copy.buffer;

			await this.fsService.writeBinaryAuto(filePath, new Uint8Array(buffer));

			this.setDirty(filePath, false);
		} catch (e: unknown) {
			this.log.error(`Failed to persist database: ${filePath}`, e);
			// Propagate critical I/O errors so callers can handle/notify
			throw e;
		}
	}

	public async createInMemoryDatabase(): Promise<Database> {
		const SQL = await this.getSqlJs();
		this.log.info("Creating in-memory index database");
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
			this.log.info(`Closing database: ${filePath}`);
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
		this.log.info("Disposing all managed databases...");
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

		this.sqlJsLazy.reset();
	}
}
