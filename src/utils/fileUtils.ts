import { normalizePath, Notice, type Vault } from "obsidian";
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
    const extSeparator = originalFileName.includes(".") ? "." : ""; // Handle files with no extension
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

export async function ensureParentDirectory(
    vault: Vault,
    filePath: string,
): Promise<void> {
    const dirPath = normalizePath(
        filePath.substring(0, filePath.lastIndexOf("/")),
    );
    const dirExists = vault.getFolderByPath(dirPath);

    if (!dirExists) {
        await vault.createFolder(dirPath);
    }
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
    let detailedMessage =
        `Error ${operationDescription} "${filePath}": ${baseError.message}`;

    const errorCode =
        typeof error === "object" && error !== null && "code" in error &&
            typeof error.code === "string"
            ? error.code
            : undefined;

    if (errorCode) {
        detailedMessage += ` (Code: ${errorCode})`;
        switch (errorCode) { 
            case "ENOENT":
                userMessage = userMessage ?? `Not found: ${filePath}`;
                detailedMessage =
                    `File/Directory not found: ${filePath}. Operation: ${operationDescription}.`;
                break;
            case "EPERM":
            case "EACCES":
                userMessage = userMessage ?? `Permission denied: ${filePath}`;
                detailedMessage =
                    `Permission/Access denied for ${filePath}. Operation: ${operationDescription}.`;
                break;
            case "EISDIR":
                userMessage = userMessage ??
                    `Expected a file but found a directory: ${filePath}`;
                detailedMessage =
                    `Path is a directory, but a file was expected: ${filePath}. Operation: ${operationDescription}.`;
                break;
            case "ENOTDIR":
                userMessage = userMessage ??
                    `Expected a directory but found a file: ${filePath}`;
                detailedMessage =
                    `Path is a file, but a directory was expected: ${filePath}. Operation: ${operationDescription}.`;
                break;
        }
    }

    userMessage = userMessage ??
        `Failed to ${
            operationDescription.split(" ")[0]
        } ${filePath}. Check console.`;

    devError(detailedMessage, baseError.stack);
    new Notice(userMessage, 7000);

    if (shouldThrow) {
        throw new Error(
            `Operation failed: ${operationDescription} for ${filePath}. Reason: ${baseError.message}`,
        );
    }
    return baseError;
}
