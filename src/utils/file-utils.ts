import { normalizePath, Notice, type Vault } from "obsidian";
import { devError } from "./logging";

export async function generateUniqueFilePath(
    vault: Vault,
    baseDir: string,
    fileName: string,
    maxFileNameLength?: number,
): Promise<string> {
    const normalizedBaseDir = normalizePath(baseDir);
    let normalizedFileName = normalizePath(fileName);

    if (maxFileNameLength && normalizedFileName.length > maxFileNameLength) {
        const ext = normalizedFileName.substring(
            normalizedFileName.lastIndexOf("."),
        );
        const baseName = normalizedFileName.substring(
            0,
            normalizedFileName.lastIndexOf("."),
        );
        normalizedFileName = `${
            baseName.slice(0, maxFileNameLength - ext.length)
        }${ext}`;
    }

    let counter = 1;
    let newPath = normalizePath(`${normalizedBaseDir}/${normalizedFileName}`);
    const baseName = normalizedFileName.substring(
        0,
        normalizedFileName.lastIndexOf("."),
    );
    const ext = normalizedFileName.substring(
        normalizedFileName.lastIndexOf("."),
    );

    while (vault.getAbstractFileByPath(newPath)) {
        newPath = normalizePath(
            `${normalizedBaseDir}/${baseName} (${counter})${ext}`,
        );
        counter++;
    }

    return newPath;
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

export async function handleDirectoryError(
    filePath: string,
    error: NodeJS.ErrnoException,
) {
    switch (error.code) {
        case "ENOENT":
            devError(`File/Directory not found: ${filePath}`);
            new Notice(`File/Directory not found: ${filePath}`);
            break;
        case "EPERM":
            devError(`Permission denied for file/directory: ${filePath}`);
            break;
        case "EACCES":
            devError(`Access denied for file/directory: ${filePath}`);
            break;
        default:
            devError(`Error reading file/directory ${filePath}:`, error);
    }
}
