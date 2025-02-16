import luaparser from "luaparse";
import type {
    Expression,
    TableConstructorExpression,
    TableKey,
    TableKeyString,
    TableValue,
} from "luaparse/lib/ast";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join as node_join } from "node:path";
import { getBookStatistics } from "./db";
import { createFrontmatterData } from "./frontmatter";
import type {
    Annotation,
    DocProps,
    FrontmatterSettings,
    LuaMetadata,
    LuaValue,
} from "./types";
import {
    devError,
    devLog,
    devWarn,
    findAndReadMetadataFile,
    getFileNameWithoutExt,
    handleDirectoryError,
} from "./utils";

const SDR_DIR_SUFFIX = ".sdr";

// Cache for common string operations
const STRING_CACHE = new Map<string, string>();

const DEFAULT_METADATA: LuaMetadata = {
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

function cleanString(rawValue: string): string {
    return rawValue
        .replace(/^"(.*)"$/, "$1") // Remove surrounding quotes
        .replace(/ΓÇö/g, "—") // Fix em dashes
        .replace(/\\(.)/g, "$1") // Handle other escape sequences
        .replace(/\"/g, ""); // Remove any remaining quotes
}

function sanitizeString(rawValue: string): string {
    const cached = STRING_CACHE.get(rawValue);
    if (cached) return cached;

    const cleaned = cleanString(rawValue); // Use the utility function

    // Cache result
    if (STRING_CACHE.size > 1000) STRING_CACHE.clear();
    STRING_CACHE.set(rawValue, cleaned);

    return cleaned;
}

export async function findSDRFiles(
    rootDir: string,
    excludedFolders: string[],
    allowedFileTypes: string[],
): Promise<string[]> {
    const sdrFiles: string[] = [];
    const excludedSet = new Set(excludedFolders);

    async function traverseDir(directory: string): Promise<void> {
        let entries: Dirent[];
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            await handleDirectoryError(
                directory,
                error as NodeJS.ErrnoException,
            );
            return;
        }

        const processPromises = entries.map(async (entry) => {
            const fullPath = node_join(directory, entry.name);

            if (excludedSet.has(entry.name)) return;

            if (entry.isDirectory()) {
                if (entry.name.endsWith(SDR_DIR_SUFFIX)) {
                    if (
                        await findAndReadMetadataFile(
                            fullPath,
                            allowedFileTypes,
                        ) !== null
                    ) {
                        sdrFiles.push(fullPath);
                        devLog("Found .sdr directory:", fullPath);
                    } else if (allowedFileTypes.length > 0) {
                        devWarn(
                            `No matching metadata file found in ${fullPath}. Allowed file types were ${
                                allowedFileTypes.join(", ")
                            }.`,
                        );
                    }
                } else {
                    await traverseDir(fullPath);
                }
            }
        });

        await Promise.all(processPromises);
    }

    await traverseDir(rootDir);
    return sdrFiles;
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
                value = cleanString(subField.value.raw).replace(/\\\n/g, ", "); // Replace escaped newlines with commas and space;
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
            title: "Untitled",
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
                    case "annotations": {
                        // Modern format (post-2024)
                        const extractedAnnotations = extractAnnotations(field);
                        if (extractedAnnotations.length > 0) {
                            result.annotations = extractedAnnotations;
                        }
                        break;
                    }
                    case "highlight": {
                        // Legacy format (pre-2024)
                        if (result.annotations.length === 0) { // Only process if no modern annotations found
                            const extractedAnnotations =
                                extractLegacyAnnotations(field);
                            if (extractedAnnotations.length > 0) {
                                result.annotations = extractedAnnotations;
                            }
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

type LuaTableField = TableKey | TableKeyString | TableValue;

function extractValue(
    field: LuaTableField,
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

function extractKeyFromField(field: LuaTableField): string | number | null {
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

function extractAnnotations(field: TableKey): Annotation[] {
    if (field.value.type !== "TableConstructorExpression") return [];

    const annotations: Annotation[] = [];
    const keyRaw = field.key?.type === "StringLiteral" ? field.key.raw : "";
    // Handle modern format (post-2024)
    if (keyRaw.includes("annotations")) {
        // Each field in the annotations table is a numerically indexed entry
        for (const entry of field.value.fields) {
            const annotation = extractModernAnnotation(entry);
            if (annotation) annotations.push(annotation);
        }
    } else if (keyRaw.includes("highlight")) {
        for (const pageField of field.value.fields) {
            if (pageField.type !== "TableKey") continue;

            const pageAnnotations = extractLegacyAnnotations(pageField);
            annotations.push(...pageAnnotations);
        }
    }

    return annotations;
}

function extractModernAnnotation(entry: LuaTableField): Annotation | null {
    if (entry.value?.type !== "TableConstructorExpression") {
        return null;
    }
    const annotation: Annotation = {
        chapter: "",
        datetime: "",
        pageno: 0,
        text: "",
    };

    for (const field of entry.value.fields) {
        const key = extractKeyFromField(field);
        if (!key) continue;

        if (field.value.type === "StringLiteral") {
            const value = field.value.raw.replace(/^"(.*)"$/, "$1");
            switch (key) {
                case "chapter":
                    annotation.chapter = value;
                    break;
                case "datetime":
                    annotation.datetime = value;
                    break;
                case "pageno":
                case "page":
                    annotation.pageno = Number.parseInt(value, 10) || 0;
                    break;
                case "text":
                    annotation.text = sanitizeString(value).replace(
                        /\\\n/g,
                        "\n\n",
                    );
                    break;
            }
        } else if (
            field.value.type === "NumericLiteral" &&
            (key === "pageno" || key === "page")
        ) {
            annotation.pageno = field.value.value;
        }
    }

    return annotation.text || annotation.chapter ? annotation : null;
}

function extractLegacyAnnotations(field: TableKey): Annotation[] {
    if (field.value.type !== "TableConstructorExpression") return [];

    const annotations: Annotation[] = [];
    for (const pageField of field.value.fields) {
        if (pageField.type !== "TableKey") continue;

        const pageNumber = extractPageNumber(pageField);
        if (pageNumber === null) continue;

        if (pageField.value.type !== "TableConstructorExpression") {
            devWarn(
                `Expected TableConstructorExpression for page ${pageNumber}`,
            );
            continue;
        }

        for (const highlightGroup of pageField.value.fields) {
            if (
                highlightGroup.type !== "TableKey" || !highlightGroup.value ||
                highlightGroup.value.type !== "TableConstructorExpression"
            ) {
                devWarn(
                    `Unexpected structure for highlight group on page ${pageNumber}`,
                );
                continue;
            }

            const highlightFields = highlightGroup.value.fields;
            const annotation = extractLegacyHighlight(
                highlightFields,
                pageNumber,
            );
            if (annotation) annotations.push(annotation);
        }
    }
    return annotations;
}

function extractLegacyHighlight(
    fields: LuaTableField[],
    pageNumber: number,
): Annotation | null {
    const annotation: Annotation = {
        chapter: "",
        datetime: "",
        pageno: pageNumber,
        text: "",
    };

    for (const field of fields) {
        if (field.type !== "TableKey") {
            devWarn(
                `extractLegacyHighlight: Expected TableKey for field but got ${field.type}`,
            );
            continue;
        }

        const key = extractKeyFromField(field);
        if (!key || typeof key !== "string") {
            devWarn(
                "extractLegacyHighlight: Could not extract valid key from field",
            );
            continue;
        }

        switch (key) {
            case "datetime":
                if (field.value.type === "StringLiteral") {
                    annotation.datetime = field.value.raw.replace(
                        /^"(.*)"$/,
                        "$1",
                    );
                }
                break;
            case "text":
                if (field.value.type === "StringLiteral") {
                    annotation.text = sanitizeString(field.value.raw).replace(
                        /\\\n/g,
                        "\n\n",
                    );
                }
                break;
            default:
                devLog(`extractLegacyHighlight: Unhandled key: ${key}`);
        }
    }

    return annotation.datetime && annotation.text ? annotation : null;
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
    allowedFileTypes: string[],
    frontmatterSettings: FrontmatterSettings,
): Promise<LuaMetadata> {
    try {
        // 1. Parallel file operations
        const content = await findAndReadMetadataFile(
            filePath,
            allowedFileTypes,
        );
        if (!content) {
            return {
                ...DEFAULT_METADATA,
                frontmatter: createFrontmatterData(
                    DEFAULT_METADATA,
                    frontmatterSettings,
                ),
            };
        }

        // 2. Streamlined metadata parsing
        const metadata = parseHighlights(content);
        const fallbackName = getFileNameWithoutExt(filePath);

        // 3. Efficient fallback handling
        if (!metadata.docProps.title || !metadata.docProps.authors) {
            metadata.docProps.title ||= fallbackName;
            metadata.docProps.authors ||= fallbackName;
        }

        // 4. Conditional metadata fetching
        metadata.frontmatter = createFrontmatterData(
            metadata,
            frontmatterSettings,
        );

        try {
            const stats = await getBookStatistics(
                "D:/statistics.sqlite3",
                metadata.docProps.authors,
                metadata.docProps.title,
            );

            if (stats) {
                metadata.statistics = {
                    book: stats.book,
                    readingSessions: stats.readingSessions,
                    derived: stats.derived,
                };
            }
        } catch (error) {
            devError("Non-critical error fetching stats:", error);
        }

        // 6. Add file system metadata
        // metadata.fileInfo = {
        //     size: fileStats.size,
        //     mtime: fileStats.mtime.toISOString()
        // };

        return metadata;
    } catch (error) {
        devError(`Error processing ${filePath}:`, error);
        return {
            ...DEFAULT_METADATA,
            frontmatter: createFrontmatterData(
                DEFAULT_METADATA,
                frontmatterSettings,
            ),
        };
    }
}

// Helper function to check if a value is a LuaValue
function isLuaValue(value: Expression): value is LuaValue {
    return (
        value.type === "StringLiteral" ||
        value.type === "NumericLiteral" ||
        value.type === "BooleanLiteral" ||
        value.type === "TableConstructorExpression"
    );
}
