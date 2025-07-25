import { promises as fsp } from "node:fs";
import path from "node:path";
import { Notice, normalizePath, type TFile, type Vault } from "obsidian";
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

/** split name + extension (extension keeps leading dot) */
const splitFileName = (f: string): { base: string; ext: string } => {
	const idx = f.lastIndexOf(".");
	return idx === -1
		? { base: f, ext: "" }
		: { base: f.slice(0, idx), ext: f.slice(idx) };
};

/* ------------------------------------------------------------------ */
/*                             API                                    */
/* ------------------------------------------------------------------ */

export async function generateUniqueFilePath(
	vault: Vault,
	baseDir: string,
	fileName: string,
): Promise<string> {
	const dir = normalizePath(baseDir);
	const orig = normalizePath(fileName);
	const { base, ext } = splitFileName(orig);

	let counter = 0;
	let candidate = normalizePath(`${dir}/${orig}`);

	while (await vault.adapter.exists(candidate)) {
		counter += 1;
		candidate = normalizePath(`${dir}/${base} (${counter})${ext}`);
	}
	return candidate;
}

const fileCreateLock = new Map<Vault, Promise<void>>();

async function withVaultLock<T>(
	vault: Vault,
	fn: () => Promise<T>,
): Promise<T> {
	const prev = fileCreateLock.get(vault) ?? Promise.resolve();
	let unlock: () => void;
	let next = new Promise<void>((res) => {
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

export async function ensureParentDirectory(
	vault: Vault,
	filePath: string,
): Promise<void> {
	const idx = normalizePath(filePath).lastIndexOf("/");
	if (idx !== -1) await ensureFolderExists(vault, filePath.slice(0, idx));
}

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
 */
export function isFileMissing(err: unknown): boolean {
	return (err as { code?: string })?.code === "ENOENT";
}
