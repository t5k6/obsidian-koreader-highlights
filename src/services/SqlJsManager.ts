import initSqlJs, { type SqlJsStatic } from "sql.js";
import { SQLITE_WASM } from "src/binaries/sql-wasm-base64";
import type { Disposable } from "src/types";

export class SqlJsManager implements Disposable {
	private sqlJsInstance: SqlJsStatic | null = null;
	private sqlJsInit: Promise<SqlJsStatic> | null = null;

	public async getSqlJs(): Promise<SqlJsStatic> {
		if (this.sqlJsInstance) return this.sqlJsInstance;
		if (this.sqlJsInit) return this.sqlJsInit;

		const nodeBuffer = Buffer.from(SQLITE_WASM, "base64");
		const wasmBinary = nodeBuffer.buffer.slice(
			nodeBuffer.byteOffset,
			nodeBuffer.byteOffset + nodeBuffer.byteLength,
		);

		this.sqlJsInit = initSqlJs({ wasmBinary })
			.then((sql) => {
				this.sqlJsInstance = sql;
				this.sqlJsInit = null;
				return sql;
			})
			.catch((err) => {
				this.sqlJsInit = null;
				throw err;
			});
		return this.sqlJsInit;
	}

	async dispose(): Promise<void> {
		// sql.js instances don't have a global dispose method.
		// The individual DB handles will be closed by their respective services.
		this.sqlJsInstance = null;
		this.sqlJsInit = null;
	}
}
