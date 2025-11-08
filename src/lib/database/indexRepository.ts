import type { Database } from "sql.js";
import type { IndexDatabase } from "src/services/vault/index/IndexDatabase";
import {
	executeTyped,
	executeWrite,
	QueryBuilders,
	RowMappers,
} from "src/services/vault/index/schema";
import { formatError } from "../errors/types";
import type { IndexDbExecutor } from "./IndexDbExecutor";
import { ConcurrentDbExecutor } from "./IndexDbExecutor";
import type { BookRow, ImportSourceRow } from "./types";

/**
 * Consolidated Data Access Layer for index.db.
 * Combines book/instance CRUD, import source tracking, and high-level composite operations.
 * Sole repository for all index database interactions.
 */
export class IndexRepository {
	private db: IndexDbExecutor | null = null;

	constructor(private readonly indexDb: IndexDatabase) {}

	private async getDb(): Promise<IndexDbExecutor> {
		await this.indexDb.whenReady();
		if (!this.db) {
			this.db = new ConcurrentDbExecutor(this.indexDb.getConcurrent());
		}
		return this.db;
	}

	/**
	 * Delete a single note instance and, if applicable, reset its import source.
	 *
	 * Returns the sourcePath that was reset (deleted) if any,
	 * so callers can log or react without knowing DB details.
	 */
	async deleteNoteAndResetSource(notePath: string): Promise<string | null> {
		const db = await this.getDb();
		return db.write((d: Database) => {
			// Find the book key for this note instance
			const findKeyQuery = QueryBuilders.selectBookKeyByPath(notePath);
			const [bookKey] = executeTyped(d, findKeyQuery, RowMappers.bookKey);

			let resetSource: string | null = null;

			if (bookKey) {
				// Find latest import source for this book
				const latestSourceQuery = QueryBuilders.latestSourceForBook(bookKey);
				const [sourcePath] = executeTyped(
					d,
					latestSourceQuery,
					RowMappers.sourcePath,
				);

				if (sourcePath) {
					// Delete the import source entry (reset status)
					const deleteSourceQuery =
						QueryBuilders.deleteImportSourceByPath(sourcePath);
					executeWrite(d, deleteSourceQuery);
					resetSource = sourcePath;
				}
			}

			// Delete the book instance (triggers GC behavior in schema)
			const deleteInstanceQuery = QueryBuilders.deleteInstanceByPath(notePath);
			executeWrite(d, deleteInstanceQuery);

			return resetSource;
		});
	}

	/**
	 * Delete all note instances inside a folder.
	 * Returns the number of rows affected.
	 */
	async deleteInstancesInFolder(folderPath: string): Promise<number> {
		const db = await this.getDb();
		return db.write((d: Database) => {
			executeWrite(d, {
				sql: "DELETE FROM book_instances WHERE vault_path LIKE ?",
				params: [`${folderPath}/%`] as const,
			});
			return d.getRowsModified();
		});
	}

	/**
	 * Upsert a book + instance from metadata and return change summary.
	 *
	 * This encapsulates the write branch of IndexCoordinator._handleMetadataChange.
	 */
	async upsertFromMetadata(
		filePath: string,
		metadata: { key: string; title: string; authors: string },
	): Promise<{
		changed: boolean;
		oldKey: string | null;
		newKey: string | null;
	}> {
		const db = await this.getDb();
		return db.write((d: Database) => {
			const findKeyQuery = QueryBuilders.selectBookKeyByPath(filePath);
			const bookKeys = executeTyped(d, findKeyQuery, RowMappers.bookKey);
			const oldKey = bookKeys[0] ?? null;

			const upsertQueries = [
				QueryBuilders.upsertBook(
					metadata.key,
					null,
					metadata.title,
					metadata.authors,
				),
				QueryBuilders.upsertInstance(metadata.key, filePath),
			];

			for (const q of upsertQueries) {
				executeWrite(d, q);
			}

			return {
				changed: true,
				oldKey,
				newKey: metadata.key,
			};
		});
	}

	/**
	 * Delete instance when metadata no longer matches and report change summary.
	 * This encapsulates the "no metadata" branch of metadata handling.
	 */
	async deleteInstanceForFile(
		filePath: string,
	): Promise<{ changed: boolean; oldKey: string | null }> {
		const db = await this.getDb();
		return db.write((d: Database) => {
			const findKeyQuery = QueryBuilders.selectBookKeyByPath(filePath);
			const bookKeys = executeTyped(d, findKeyQuery, RowMappers.bookKey);
			const oldKey = bookKeys[0] ?? null;

			if (oldKey) {
				const deleteInstanceQuery =
					QueryBuilders.deleteInstanceByPath(filePath);
				executeWrite(d, deleteInstanceQuery);
				return { changed: true, oldKey };
			}

			return { changed: false, oldKey: null };
		});
	}

	/**
	 * Record import success + optional book/instance upsert in one transaction.
	 *
	 * Mirrors the logic from IndexCoordinator.recordImportSuccess.
	 */
	async recordImportSuccess(params: {
		path: string;
		mtime: number;
		size: number;
		newestAnnotationTs: string | null;
		bookKey?: string | null;
		md5?: string | null;
		vaultPath?: string | null;
		title?: string;
		authors?: string;
	}): Promise<void> {
		const db = await this.getDb();
		await db.write((d: Database) => {
			const upsertSource = QueryBuilders.upsertImportSourceSuccess(
				params.path,
				params.mtime,
				params.size,
				params.newestAnnotationTs,
				Date.now(),
				params.bookKey ?? null,
				params.md5 ?? null,
			);
			executeWrite(d, upsertSource);

			if (params.vaultPath && params.bookKey) {
				const book: BookRow = {
					key: params.bookKey,
					id: null,
					title: params.title ?? "Untitled",
					authors: params.authors ?? "Unknown Author",
				};

				const upsertBook = QueryBuilders.upsertBook(
					book.key,
					book.id,
					book.title,
					book.authors,
				);
				const upsertInstance = QueryBuilders.upsertInstance(
					book.key,
					params.vaultPath,
				);

				executeWrite(d, upsertBook);
				executeWrite(d, upsertInstance);
			}
		});
	}

	/**
	 * Record import failure.
	 */
	async recordImportFailure(path: string, error: unknown): Promise<void> {
		const db = await this.getDb();
		await db.write((d: Database) => {
			const msg = formatError(error);
			const upsert = QueryBuilders.upsertImportSourceFailure(path, 0, 0, msg);
			executeWrite(d, upsert);
		});
	}

	// === Methods from BookRepository ===

	/**
	 * Resolve book key for a given note path.
	 */
	async findKeyByPath(vaultPath: string): Promise<string | null> {
		const db = await this.getDb();
		return db.read((d: Database) => {
			const q = QueryBuilders.selectBookKeyByPath(vaultPath);
			const rows = executeTyped(d, q, RowMappers.bookKey);
			return rows[0] ?? null;
		});
	}

	/**
	 * Resolve all note paths for a given book key.
	 */
	async findPathsByKey(bookKey: string): Promise<string[]> {
		const db = await this.getDb();
		return db.read((d: Database) => {
			const q = QueryBuilders.selectPathsByBookKey(bookKey);
			return executeTyped(d, q, RowMappers.vaultPath);
		});
	}

	/**
	 * Upsert a book and (optionally) its instance for a given path.
	 */
	async upsertBookWithInstance(
		book: BookRow,
		vaultPath?: string,
	): Promise<void> {
		const db = await this.getDb();
		await db.write((d: Database) => {
			const queries = [
				QueryBuilders.upsertBook(book.key, book.id, book.title, book.authors),
				...(vaultPath
					? [QueryBuilders.upsertInstance(book.key, vaultPath)]
					: []),
			];
			for (const q of queries) {
				executeWrite(d, q);
			}
		});
	}

	/**
	 * Ensure a book exists by key.
	 */
	async ensureBookExists(key: string): Promise<void> {
		const db = await this.getDb();
		await db.write((d: Database) => {
			const q = QueryBuilders.insertBookIfNotExists(key);
			executeWrite(d, q);
		});
	}

	/**
	 * Delete a book instance at the given path.
	 * Returns true if something was removed.
	 */
	async deleteInstanceByPath(vaultPath: string): Promise<boolean> {
		const db = await this.getDb();
		return db.write((d: Database) => {
			const q = QueryBuilders.deleteInstanceByPath(vaultPath);
			executeWrite(d, q);
			return d.getRowsModified() > 0;
		});
	}

	/**
	 * Handle folder rename for all instances.
	 */
	async handleRenameFolder(oldPath: string, newPath: string): Promise<void> {
		const db = await this.getDb();
		await db.write((d: Database) => {
			const q = QueryBuilders.renameFolder(
				`${oldPath}/`,
				`${newPath}/`,
				`${oldPath}/%`,
			);
			executeWrite(d, q);
		});
	}

	/**
	 * Handle file rename for a single instance.
	 */
	async handleRenameFile(oldPath: string, newPath: string): Promise<void> {
		const db = await this.getDb();
		await db.write((d: Database) => {
			const q = QueryBuilders.renameFile(newPath, oldPath);
			executeWrite(d, q);
		});
	}

	// === Methods from SourceRepository ===

	/**
	 * Get import source by path.
	 */
	async getByPath(sourcePath: string): Promise<ImportSourceRow | null> {
		const db = await this.getDb();
		return db.read((d: Database) => {
			const q = QueryBuilders.getImportSourceByPath(sourcePath);
			const rows = executeTyped(d, q, RowMappers.importSource);
			return rows[0] ?? null;
		});
	}

	/**
	 * Upsert a successful import source.
	 */
	async upsertSuccess(
		sourcePath: string,
		mtime: number,
		size: number,
		newestAnnotationTs: string | null,
		bookKey?: string | null,
		md5?: string | null,
	): Promise<void> {
		const db = await this.getDb();
		await db.write((d: Database) => {
			const q = QueryBuilders.upsertImportSourceSuccess(
				sourcePath,
				mtime,
				size,
				newestAnnotationTs,
				Date.now(),
				bookKey ?? null,
				md5 ?? null,
			);
			executeWrite(d, q);
		});
	}

	/**
	 * Upsert a failed import source.
	 */
	async upsertFailure(sourcePath: string, error: unknown): Promise<void> {
		const msg = formatError(error);
		const db = await this.getDb();
		await db.write((d: Database) => {
			const q = QueryBuilders.upsertImportSourceFailure(sourcePath, 0, 0, msg);
			executeWrite(d, q);
		});
	}

	/**
	 * Delete an import source by path.
	 */
	async deleteByPath(sourcePath: string): Promise<void> {
		const db = await this.getDb();
		await db.write((d: Database) => {
			const q = QueryBuilders.deleteImportSourceByPath(sourcePath);
			executeWrite(d, q);
		});
	}

	/**
	 * Clear all import sources.
	 */
	async clearAll(): Promise<void> {
		const db = await this.getDb();
		await db.write((d: Database) => {
			const q = QueryBuilders.clearAllImportSources();
			executeWrite(d, q);
		});
	}

	/**
	 * Find the latest source path for a given book key.
	 */
	async latestSourceForBook(bookKey: string): Promise<string | null> {
		const db = await this.getDb();
		return db.read((d: Database) => {
			const q = QueryBuilders.latestSourceForBook(bookKey);
			const rows = executeTyped(d, q, RowMappers.sourcePath);
			return rows[0] ?? null;
		});
	}

	/**
	 * Get import sources by MD5.
	 */
	async getImportSourcesByMd5(
		md5: string,
	): Promise<
		Array<{ source_path: string; book_key: string | null; md5: string | null }>
	> {
		const db = await this.getDb();
		return db.read((d: Database) => {
			const q = {
				sql: "SELECT source_path, book_key, md5 FROM import_source WHERE md5 = ?",
				params: [md5] as const,
			};
			return executeTyped(d, q, (row) => ({
				source_path: row.source_path as string,
				book_key: row.book_key as string | null,
				md5: row.md5 as string | null,
			}));
		});
	}

	/**
	 * Determine if a source should be processed based on existing data.
	 */
	static shouldProcess(
		existing: ImportSourceRow | null,
		stats: { mtime: number; size: number },
		newestAnnotationTs: string | null,
		md5: string | null,
	): boolean {
		if (!existing) return true; // Always process if it's a new source

		// If there was a previous error, always re-process
		if (existing.last_error !== null || existing.last_success_ts === null)
			return true;

		// 1. Content Hash Check (Most Reliable)
		// If both the old record and the new file have an MD5, trust it over mtime.
		if (existing.md5 && md5) {
			if (existing.md5 !== md5) {
				return true; // Content has definitively changed.
			}

			// If MD5s match, check if there are newer annotations reported.
			// This handles the edge case where highlights are added but MD5 isn't updated by KOReader (unlikely but safe).
			return !!(
				newestAnnotationTs &&
				newestAnnotationTs > (existing.newest_annotation_ts ?? "")
			);
		}
		// 2. Fallback to Filesystem Metadata (Less Reliable)
		// This path is now only taken if MD5 is not available on one or both sides.
		if (
			existing.last_processed_mtime !== stats.mtime ||
			existing.last_processed_size !== stats.size
		)
			return true;

		// 3. Final check on annotation timestamp as a last resort
		return !!(
			newestAnnotationTs &&
			newestAnnotationTs > (existing.newest_annotation_ts ?? "")
		);
	}
}
