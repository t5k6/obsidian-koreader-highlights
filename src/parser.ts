import { readdir, readFile, stat } from "node:fs/promises";
import { join as node_join } from "node:path";
import type { Dirent } from "node:fs";
import luaparser from "luaparse";
import type {
    Expression,
    TableConstructorExpression,
    TableKey,
    TableKeyString,
    TableValue,
} from "luaparse/lib/ast";
import type {
    Annotation,
    DocProps,
    Field,
    LuaMetadata,
    LuaValue,
} from "./types";
import { devError, devLog, devWarn, handleDirectoryError } from "./utils";

const SDR_DIR_SUFFIX = ".sdr";

export async function findSDRFiles(
    rootDir: string,
    excludedFolders: string[],
    allowedFileTypes: string[],
): Promise<string[]> {
    const sdrFiles: string[] = [];
    devLog("Starting findSDRFiles:", rootDir);

    async function traverseDir(directory: string) {
        let entries: Dirent[];
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (readDirError) {
            const error = readDirError as NodeJS.ErrnoException;
            await handleDirectoryError(directory, error);
            return;
        }

        for (const entry of entries) {
            const fullPath = node_join(directory, entry.name);

            if (excludedFolders.includes(entry.name)) continue;

            if (
                entry.isDirectory() && entry.name.endsWith(SDR_DIR_SUFFIX)
            ) {
                if (await hasAllowedMetadataFile(fullPath, allowedFileTypes)) {
                    sdrFiles.push(fullPath);
                    devLog("Found .sdr directory:", fullPath);
                } else if (allowedFileTypes.length > 0) {
                    devWarn(
                        `No matching metadata file found in ${fullPath}. Allowed file types were ${
                            allowedFileTypes.join(", ")
                        }.`,
                    );
                }
                continue;
            }

            if (entry.isDirectory()) {
                await traverseDir(fullPath);
            }
        }
    }

    await traverseDir(rootDir);
    return sdrFiles;
}
async function hasAllowedMetadataFile(
    directory: string,
    allowedFileTypes: string[],
): Promise<boolean> {
    // If no file types are specified, check for any metadata file
    const isFileTypeFilterEmpty = allowedFileTypes.length === 0 ||
        (allowedFileTypes.length === 1 && allowedFileTypes[0] === "");
    if (isFileTypeFilterEmpty) {
        try {
            const files = await readdir(directory);
            for (const file of files) {
                const match = file.match(/^metadata\.\w+\.lua$/);
                if (match) {
                    const metadataPath = node_join(directory, file);
                    if ((await stat(metadataPath)).isFile()) return true;
                }
            }
            // No metadata file found
            return false;
        } catch (error) {
            devError(
                `Error reading directory ${directory}:`,
                error,
            );
            return false;
        }
    } else {
        // Check for specific file types
        for (const fileType of allowedFileTypes) {
            const metadataPath = node_join(
                directory,
                `metadata.${fileType}.lua`,
            );
            try {
                if ((await stat(metadataPath)).isFile()) return true;
            } catch (metadataError) {
                const error = metadataError as NodeJS.ErrnoException;
                await handleDirectoryError(metadataPath, error);
            }
        }
        return false;
    }
}

function sanitizeString(rawValue: string): string {
    const value = rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;
    return value.replace(/\\/g, "");
}

function extractDocProps(field: TableKey | TableValue): DocProps {
    const docProps: DocProps = {
        authors: "",
        title: "",
        description: "",
        keywords: "",
        series: "",
        language: "en",
    };
    const TableValue = field.value as TableConstructorExpression;
    if (TableValue.type !== "TableConstructorExpression") return docProps;

    for (const subField of TableValue.fields) {
        if (
            subField.type !== "TableKey" ||
            subField.key.type !== "StringLiteral"
        ) continue;
        const subKey =
            subField.key.raw.startsWith('"') && subField.key.raw.endsWith('"')
                ? subField.key.raw.slice(1, -1)
                : subField.key.raw;

        if (subKey in docProps) {
            let value = "";

            if (subField.value.type === "StringLiteral") {
                value = subField.value.raw
                    .replace(/^"(.*)"$/, "$1")
                    .replace(/\\\n/g, ", ")
                    .replace(/\\(.)/g, "$1")
                    .replace(/\"/g, "");
            } else if (subField.value.type === "NumericLiteral") {
                value = subField.value.value.toString();
            } else if (subField.value.type === "BooleanLiteral") {
                value = subField.value.value.toString();
            } else if (subField.value.type === "NilLiteral") {
                value = "";
            } else {
                devWarn(
                    `Unhandled value type for doc_prop '${subKey}': ${subField.value.type}`,
                );
            }

            docProps[subKey as keyof DocProps] = value;
        } else {
            devWarn(`Unknown doc_prop key: ${subKey}`);
        }
    }
    return docProps;
}
export function parseHighlights(text: string): LuaMetadata {
    const defaultResult: LuaMetadata = {
        docProps: {
            authors: "Unknown Author",
            title: "",
            description: "",
            keywords: "",
            series: "",
            language: "en",
        },
        pages: 0,
        annotations: [],
    };

    try {
        const ast = luaparser.parse(text);

        if (!ast.body?.[0] || ast.body[0].type !== "ReturnStatement") {
            devError("Invalid Lua structure: No return statement found");
            return defaultResult;
        }

        const returnValue = ast.body[0].arguments?.[0];
        if (!returnValue) {
            devError("Invalid Lua structure: No return value found");
            return defaultResult;
        }

        const result: LuaMetadata = { ...defaultResult };
        let creDomVersion: number | null = null;

        if (returnValue.type === "TableConstructorExpression") {
            for (const field of returnValue.fields) {
                if (field.type !== "TableKey") {
                    devWarn(`Skipping non-table key field: ${field.type}`);
                    continue;
                }

                const key = extractKeyFromField(field);
                if (!key) continue;

                switch (key) {
                    case "doc_props":
                        result.docProps = {
                            ...result.docProps,
                            ...extractDocProps(field),
                        };
                        break;
                    case "cre_dom_version":
                        if (
                            "type" in field.value &&
                            ["NumericLiteral", "StringLiteral"].includes(
                                field.value.type,
                            )
                        ) {
                            creDomVersion = extractVersionNumber(
                                field.value as LuaValue,
                            );
                        } else {
                            devWarn(
                                `Unexpected value type for cre_dom_version: ${field.value.type}`,
                            );
                        }
                        break;
                    case "doc_pages":
                        if (
                            "type" in field.value &&
                            ["NumericLiteral", "StringLiteral"].includes(
                                field.value.type,
                            )
                        ) {
                            result.pages =
                                extractVersionNumber(field.value as LuaValue) ??
                                    0;
                        } else {
                            devWarn(
                                `Unexpected value type for doc_pages: ${field.value.type}`,
                            );
                        }
                        break;
                    case "annotations":
                    case "highlight": {
                        const extractedAnnotations = extractAnnotations(
                            field,
                        );
                        if (extractedAnnotations.length > 0) {
                            result.annotations = extractedAnnotations;
                        }
                        break;
                    }
                        // default:
                        //     devLog(`Unhandled key: ${key}`);
                }
            }
        }
        return result;
    } catch (error) {
        const e = error as Error;
        devError("Error parsing Lua:", e.message);
        return defaultResult;
    }
}
function extractKeyFromField(field: Field): string | number | null {
    if (field.type === "TableKey" || field.type === "TableKeyString") {
        const key = field.key;
        if (key.type === "StringLiteral") {
            return key.raw.replace(/^"(.*)"$/, "$1");
        }
        if (key.type === "NumericLiteral") {
            return key.value;
        }
        if (key.type === "Identifier") {
            return key.name;
        }
    }
    devWarn(`Unexpected key type: ${field.type}`);
    return null;
}

function extractVersionNumber(value: LuaValue): number | null {
    if (value.type === "NumericLiteral") {
        return value.value;
    }
    if (value.type === "StringLiteral") {
        return value.value ? Number.parseInt(value.value, 10) : null;
    }
    return null;
}

function extractValue(
    field: Field,
): string | number | boolean | Record<string, unknown> | null {
    if (
        (field.type === "TableValue" || field.type === "TableKey" ||
            field.type === "TableKeyString") &&
        isLuaValue(field.value)
    ) {
        return extractLuaValue(field.value);
    }
    return null;
}

function isLuaValue(value: Expression): value is LuaValue {
    return (
        value.type === "StringLiteral" ||
        value.type === "NumericLiteral" ||
        value.type === "BooleanLiteral" ||
        value.type === "TableConstructorExpression"
    );
}

function extractLuaValue(
    value: LuaValue,
): string | number | boolean | Record<string, unknown> | null {
    switch (value.type) {
        case "StringLiteral":
            return value.raw.replace(/^"(.*)"$/, "$1");
        case "NumericLiteral":
            return value.value;
        case "BooleanLiteral":
            return value.value;
        case "TableConstructorExpression":
            return value.fields.reduce<Record<string, unknown>>(
                (acc, field) => {
                    const key = extractKeyFromField(field);
                    if (key) {
                        acc[key.toString()] = extractValue(field);
                    }
                    return acc;
                },
                {},
            );
        default:
            return null;
    }
}

function extractAnnotations(
    field: TableKey,
): Annotation[] {
    if (field.value.type !== "TableConstructorExpression") {
        return [];
    }

    const annotations: Annotation[] = [];

    if (field.key?.type === "StringLiteral") {
        // Handle modern format (post-2024)
        if (field.key.raw.includes("annotations")) {
            for (const entry of field.value.fields) {
                if (entry.type !== "TableKey") {
                    continue;
                }
                if (extractKeyFromField(entry) === "highlight") continue;
                const annotation = extractModernAnnotation(entry);
                if (annotation) annotations.push(annotation);
            }
            // Handle legacy format (pre-2024)
        } else if (field.key.raw.includes("highlight")) {
            for (const pageField of field.value.fields) {
                if (pageField.type !== "TableKey") {
                    continue;
                }
                const pageAnnotations = extractLegacyAnnotations(pageField);
                annotations.push(...pageAnnotations);
            }
        }
    }
    return annotations;
}

function extractModernAnnotation(entry: TableKey): Annotation | null {
    if (
        entry.type !== "TableKey" ||
        entry.value.type !== "TableConstructorExpression"
    ) {
        return null;
    }

    const annotation: Annotation = {
        chapter: "",
        datetime: "",
        pageno: 0,
        text: "",
    };

    console.log(
        "extractModernAnnotation1",
        "entry.value.fields",
        entry.value.fields,
    );

    for (const field of entry.value.fields) {
        const key = extractKeyFromField(field);
        if (!key) continue;

        const value = extractValue(field);
        switch (key) {
            case "chapter":
                annotation.chapter = typeof value === "string" ? value : "";
                break;
            case "datetime":
                annotation.datetime = typeof value === "string" ? value : "";
                break;
            case "pageno":
                annotation.pageno = typeof value === "number" ? value : 0;
                break;
            case "text":
                annotation.text = typeof value === "string"
                    ? sanitizeString(value)
                    : "";
                break;
        }
        console.log("extractModernAnnotation2", "key", key, "value", value);
    }

    return annotation;
}
function extractLegacyAnnotations(pageField: TableKey): Annotation[] {
    const annotations: Annotation[] = [];
    const pageNumber = extractPageNumber(pageField);

    if (pageField.value.type !== "TableConstructorExpression") {
        return annotations;
    }

    for (const highlightField of pageField.value.fields) {
        if (highlightField.value.type !== "TableConstructorExpression") {
            continue;
        }

        const annotation: Annotation = {
            chapter: "",
            datetime: "",
            pageno: typeof pageNumber === "number" ? pageNumber : 0,
            text: "",
        };

        for (const field of highlightField.value.fields) {
            const key = extractKeyFromField(field);
            if (!key) continue;

            const value = extractValue(field);
            switch (key) {
                case "chapter":
                    annotation.chapter = typeof value === "string" ? value : "";
                    break;
                case "datetime":
                    annotation.datetime = typeof value === "string"
                        ? value
                        : "";
                    break;
                case "page":
                    annotation.pageno = typeof value === "number" ? value : 0;
                    break;
                case "text":
                    annotation.text = typeof value === "string"
                        ? sanitizeString(value)
                        : "";
                    break;
            }
        }

        annotations.push(annotation);
    }

    return annotations;
}

function extractPageNumber(field: TableKey | TableKeyString): number | null {
    if (field.type !== "TableKey" && field.type !== "TableKeyString") {
        return null;
    }

    const key = field.key;
    if (key.type === "NumericLiteral") {
        return key.value;
    }
    if (key.type === "StringLiteral") {
        return Number.parseInt(key.raw.replace(/^"(.*)"$/, "$1"), 10);
    }
    return null;
}
export async function readSDRFileContent(
    filePath: string,
    allowedFileTypes: string[] = [],
): Promise<LuaMetadata> {
    const isFileTypeFilterEmpty = allowedFileTypes.length === 0 ||
        (allowedFileTypes.length === 1 && allowedFileTypes[0] === "");

    if (isFileTypeFilterEmpty) {
        try {
            const files = await readdir(filePath);
            for (const file of files) {
                const match = file.match(/^metadata\..+\.lua$/);
                if (match) {
                    const luaFilePath = node_join(filePath, file);
                    const stats = await stat(luaFilePath);
                    if (!stats.isFile()) {
                        devWarn(`Skipping non-file: ${luaFilePath}`);
                        continue;
                    }
                    devLog(`File found: ${luaFilePath}`);
                    const content = await readFile(luaFilePath, "utf-8");
                    return parseHighlights(content);
                }
            }
        } catch (error) {
            const e = error as NodeJS.ErrnoException;
            await handleDirectoryError(filePath, e);
        }
    } else {
        for (const fileType of allowedFileTypes) {
            const luaFilePath = node_join(filePath, `metadata.${fileType}.lua`);
            try {
                const stats = await stat(luaFilePath);
                if (!stats.isFile()) {
                    devWarn(`Skipping non-file: ${luaFilePath}`);
                    continue;
                }
                devLog(`File found: ${luaFilePath}`);
                const content = await readFile(luaFilePath, "utf-8");
                return parseHighlights(content);
            } catch (error) {
                const e = error as NodeJS.ErrnoException;
                await handleDirectoryError(luaFilePath, e);
            }
        }
    }

    devError(
        `No valid metadata file found in ${filePath}. Returning default metadata.`,
    );
    return {
        docProps: {
            authors: "",
            title: "",
            description: "",
            keywords: "",
            series: "",
            language: "",
        },
        pages: 0,
        annotations: [],
    };
}
