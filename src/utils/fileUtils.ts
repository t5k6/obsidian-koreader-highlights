import { promises as fsp } from "node:fs";
import path from "node:path";
import { Notice, normalizePath, type TFile, type Vault } from "obsidian";
import { DEFAULT_HIGHLIGHTS_FOLDER } from "src/constants";
import { logger } from "./logging";

/* ------------------------------------------------------------------ */
/*                              TYPES                                 */
/* ------------------------------------------------------------------ */

export type FileSystemOperation =
	| "creating folder"
	| "reading file"
	| "writing file"
	| "deleting file"
	| "reading directory"
	| "reading metadata file"
	| "reading SDR directory";

export enum FileSystemErrorCode {
	NotFound = "ENOENT",
	AccessDenied = "EACCES",
	Permission = "EPERM",
	IsDirectory = "EISDIR",
	NotDirectory = "ENOTDIR",
}

type ErrorWithCode = Error & { code?: string };

interface HandleFsErrOptions {
	shouldThrow?: boolean;
	customNoticeMessage?: string;
}

/* ------------------------------------------------------------------ */
/*                           ᴜᴛɪʟɪᴛɪᴇs                               */
/* ------------------------------------------------------------------ */

/**
 * Splits a filename into base name and extension.
 * Extension includes the leading dot.
 * @param f - Filename to split
 * @returns Object with base name and extension
 */
const splitFileName = (f: string): { base: string; ext: string } => {
	const idx = f.lastIndexOf(".");
	return idx === -1
		? { base: f, ext: "" }
		: { base: f.slice(0, idx), ext: f.slice(idx) };
};

/* ------------------------------------------------------------------ */
/*                             API                                    */
/* ------------------------------------------------------------------ */

/**
 * Generates a unique file path by appending numbers if needed.
 * @param vault - Obsidian vault instance
 * @param dir - Directory path
 * @param fileName - Desired filename
 * @returns Unique file path that doesn't exist yet
 */
export async function generateUniqueFilePath(
	vault: Vault,
	dir: string,
	fileName: string,
) {
	dir = toVaultRelPath(dir || DEFAULT_HIGHLIGHTS_FOLDER); // guard
	const { base, ext } = path.parse(fileName);
	let i = 0;
	let candidate: string;
	do {
		const suffix = i ? ` (${i})` : "";
		candidate = normalizePath(`${dir}/${base}${suffix}${ext}`);
		i++;
	} while (await vault.adapter.exists(candidate));
	return candidate;
}

const fileCreateLock = new Map<Vault, Promise<void>>();

/**
 * Executes a function with vault-level locking to prevent race conditions.
 * @param vault - Obsidian vault instance
 * @param fn - Function to execute within the lock
 * @returns Result of the function execution
 */
async function withVaultLock<T>(
	vault: Vault,
	fn: () => Promise<T>,
): Promise<T> {
	const prev = fileCreateLock.get(vault) ?? Promise.resolve();
	let unlock: () => void;
	const next = new Promise<void>((res) => {
		unlock = res;
	});
	fileCreateLock.set(
		vault,
		prev.then(() => next),
	);
	try {
		await prev; // wait turn
		return await fn(); // critical section
	} finally {
		unlock!(); // release
		if (fileCreateLock.get(vault) === next) fileCreateLock.delete(vault);
	}
}

/**
 * Creates a file with automatic conflict resolution.
 * Appends numbers to filename if it already exists.
 * @param vault - Obsidian vault instance
 * @param baseDir - Directory to create file in
 * @param filenameStem - Base filename without extension
 * @param content - File content
 * @returns Created TFile instance
 */
export async function createFileSafely(
	vault: Vault,
	baseDir: string,
	filenameStem: string,
	content: string,
): Promise<TFile> {
	return withVaultLock(vault, async () => {
		let counter = 0;
		let candidate: string;
		do {
			const suffix = counter === 0 ? "" : ` (${counter})`;
			candidate = normalizePath(`${baseDir}/${filenameStem}${suffix}.md`);
			counter++;
		} while (await vault.adapter.exists(candidate));

		// final check & write
		if (await vault.adapter.exists(candidate)) {
			// extremely rare – fallback to uuid suffix
			const stamp = Date.now().toString(36).slice(-4);
			candidate = normalizePath(`${baseDir}/${filenameStem}-${stamp}.md`);
		}
		return vault.create(candidate, content);
	});
}

/**
 * Ensures a folder exists, creating it if necessary.
 * @param vault - Obsidian vault instance
 * @param folderPath - Path to the folder
 * @returns True if folder was created, false if already existed
 */
export async function ensureFolderExists(
	vault: Vault,
	folderPath: string,
): Promise<boolean> {
	const path = normalizePath(folderPath);
	if (vault.getFolderByPath(path)) return false; // in-memory fast path

	try {
		const stat = await vault.adapter.stat(path).catch(() => null);
		if (stat?.type === "folder") return false;
		if (stat) throw new Error(`"${path}" exists but is not a folder.`);

		await vault.createFolder(path);
		return true;
	} catch (err) {
		handleFileSystemError("creating folder", path, err, { shouldThrow: true });
		return false;
	}
}

/**
 * Ensures the parent directory of a file path exists.
 * @param vault - Obsidian vault instance
 * @param filePath - Path to the file
 */
export async function ensureParentDirectory(
	vault: Vault,
	filePath: string,
): Promise<void> {
	const idx = normalizePath(filePath).lastIndexOf("/");
	if (idx !== -1) await ensureFolderExists(vault, filePath.slice(0, idx));
}

/**
 * Handles filesystem errors with appropriate user notifications.
 * @param operation - Type of filesystem operation that failed
 * @param path - Path involved in the operation
 * @param error - The error that occurred
 * @param options - Options for error handling
 * @returns The processed error
 */
export function handleFileSystemError(
	operation: FileSystemOperation,
	path: string,
	error: unknown,
	{ shouldThrow = false, customNoticeMessage }: HandleFsErrOptions = {},
): Error {
	const err: ErrorWithCode =
		error instanceof Error ? error : new Error(String(error));

	let userMsg = customNoticeMessage;
	let logMsg = `Error ${operation} "${path}": ${err.message}`;

	const code = (err.code ?? "") as FileSystemErrorCode | "";

	if (code) {
		logMsg += ` (code: ${code})`;
		switch (code) {
			case FileSystemErrorCode.NotFound:
				userMsg ??= `Not found: ${path}`;
				break;
			case FileSystemErrorCode.AccessDenied:
			case FileSystemErrorCode.Permission:
				userMsg ??= `Permission denied: ${path}`;
				break;
			case FileSystemErrorCode.IsDirectory:
				userMsg ??= `Expected a file, found directory: ${path}`;
				break;
			case FileSystemErrorCode.NotDirectory:
				userMsg ??= `Expected a directory, found file: ${path}`;
				break;
		}
	}

	userMsg ??= `Failed to ${operation} – see console for details.`;

	logger.error(logMsg, err.stack);
	new Notice(userMsg, 7_000);

	if (shouldThrow) {
		throw new Error(
			`Operation failed (${operation}) on ${path}: ${err.message}`,
		);
	}
	return err;
}

/**
 * Creates parent directories if they don't exist, then writes the file.
 * For use with the Node.js filesystem, not the Obsidian Vault adapter.
 * @param filePath - Full file path
 * @param data - Data to write (string or binary)
 */
export async function writeFileEnsured(
	filePath: string,
	data: string | Uint8Array,
): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.writeFile(filePath, data);
}

/**
 * Checks if a filesystem error is a 'File Not Found' error.
 * @param err - Error to check
 * @returns True if error is ENOENT (file not found)
 */
export function isFileMissing(err: unknown): boolean {
	return (err as { code?: string })?.code === "ENOENT";
}

/**
 * Converts a path to vault-relative format.
 * Always returns a relative, slash-normalized path with no leading slash.
 * @param raw - Raw path string
 * @returns Normalized relative path
 */
export const toVaultRelPath = (raw: string): string =>
	normalizePath(raw).replace(/^\/+/, "");
