import { QueryBuilders } from "src/services/vault/index/schema";
import type { BookRow } from "./types";

export const BookRepository = {
	// Pure query functions
	findKeyByPath: (vaultPath: string) =>
		QueryBuilders.selectBookKeyByPath(vaultPath),

	findPathsByKey: (bookKey: string) =>
		QueryBuilders.selectPathsByBookKey(bookKey),

	upsertBookWithInstance: (book: BookRow, vaultPath?: string) => [
		QueryBuilders.upsertBook(book.key, book.id, book.title, book.authors),
		...(vaultPath ? [QueryBuilders.upsertInstance(book.key, vaultPath)] : []),
	],

	ensureBookExists: (key: string) => QueryBuilders.insertBookIfNotExists(key),

	deleteInstanceByPath: (vaultPath: string) =>
		QueryBuilders.deleteInstanceByPath(vaultPath),

	handleRenameFolder: (oldPath: string, newPath: string) =>
		QueryBuilders.renameFolder(`${oldPath}/`, `${newPath}/`, `${oldPath}/%`),

	handleRenameFile: (newPath: string, oldPath: string) =>
		QueryBuilders.renameFile(newPath, oldPath),
} as const;
