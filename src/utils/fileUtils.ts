import { Notice, normalizePath, type Vault } from "obsidian";
import { devError } from "./logging";

interface FileSystemError extends Error {
	code?: string;
}

export async function generateUniqueFilePath(
	vault: Vault,
	baseDir: string,
	fileName: string,
): Promise<string> {
	const normalizedBaseDir = normalizePath(baseDir);
	const originalFileName = normalizePath(fileName);

	let counter = 0;
	let currentPath = normalizePath(`${normalizedBaseDir}/${originalFileName}`);
	const extSeparator = originalFileName.includes(".") ? "." : "";
	const baseName = originalFileName.substring(
		0,
		originalFileName.lastIndexOf(extSeparator),
	);
	const ext = originalFileName.substring(
		originalFileName.lastIndexOf(extSeparator),
	);

	while (await vault.adapter.exists(currentPath)) {
		counter++;
		currentPath = normalizePath(
			`${normalizedBaseDir}/${baseName} (${counter})${ext}`,
		);
	}

	return currentPath;
}

export async function ensureFolderExists(
	vault: Vault,
	folderPath: string,
): Promise<boolean> {
	const normalized = normalizePath(folderPath);

	// Fast in-memory check
	if (vault.getFolderByPath(normalized)) {
		return false;
	}

	try {
		const stat = await vault.adapter.stat(normalized).catch(() => null);

		if (stat) {
			if (stat.type === "folder") {
				return false;
			}
			throw new Error(`"${normalized}" exists but is not a folder.`);
		}

		// If we reach here, the folder does not exist. Create it.
		await vault.createFolder(normalized);
		return true; // Was newly created
	} catch (err) {
		handleFileSystemError("creating folder", normalized, err, {
			shouldThrow: true,
		});
		return false; // Should not be reached due to throw, but satisfies TS
	}
}

export async function ensureParentDirectory(
	vault: Vault,
	filePath: string,
): Promise<void> {
	const dir = normalizePath(filePath.substring(0, filePath.lastIndexOf("/")));
	await ensureFolderExists(vault, dir);
}

export function handleFileSystemError(
	operationDescription: string,
	filePath: string,
	error: unknown,
	options: {
		shouldThrow?: boolean;
		customNoticeMessage?: string;
	} = {},
): Error {
	const { shouldThrow = false, customNoticeMessage } = options;
	const baseError = error instanceof Error ? error : new Error(String(error));

	let userMessage = customNoticeMessage;
	let detailedMessage = `Error ${operationDescription} "${filePath}": ${baseError.message}`;

	const errorCode =
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: undefined;

	if (errorCode) {
		detailedMessage += ` (Code: ${errorCode})`;
		switch (errorCode) {
			case "ENOENT":
				userMessage = userMessage ?? `Not found: ${filePath}`;
				detailedMessage = `File/Directory not found: ${filePath}. Operation: ${operationDescription}.`;
				break;
			case "EPERM":
			case "EACCES":
				userMessage = userMessage ?? `Permission denied: ${filePath}`;
				detailedMessage = `Permission/Access denied for ${filePath}. Operation: ${operationDescription}.`;
				break;
			case "EISDIR":
				userMessage =
					userMessage ?? `Expected a file but found a directory: ${filePath}`;
				detailedMessage = `Path is a directory, but a file was expected: ${filePath}. Operation: ${operationDescription}.`;
				break;
			case "ENOTDIR":
				userMessage =
					userMessage ?? `Expected a directory but found a file: ${filePath}`;
				detailedMessage = `Path is a file, but a directory was expected: ${filePath}. Operation: ${operationDescription}.`;
				break;
		}
	}

	userMessage =
		userMessage ??
		`Failed to ${operationDescription} ${filePath}. Check console.`;

	devError(detailedMessage, baseError.stack);
	new Notice(userMessage, 7000);

	if (shouldThrow) {
		throw new Error(
			`Operation failed: ${operationDescription} for ${filePath}. Reason: ${baseError.message}`,
		);
	}
	return baseError;
}
