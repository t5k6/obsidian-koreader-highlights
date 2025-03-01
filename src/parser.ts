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
import path, { join as node_join } from "node:path";
import { getBookStatistics } from "./db";
import { createFrontmatterData } from "./frontmatter";
import type {
    Annotation,
    DocProps,
    FrontmatterSettings,
    KoReaderHighlightImporterSettings,
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
        .replace(/"/g, ""); // Use straight quotes for consistency (.replace(/\"/g, "");)
}

function sanitizeString(rawValue: string): string {
    const cached = STRING_CACHE.get(rawValue);
    if (cached) return cached;

    const cleaned = cleanString(rawValue);
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
                // First: Always recursively process subdirectories
                await traverseDir(fullPath);

                // Second: Check if current directory is SDR
                if (entry.name.endsWith(SDR_DIR_SUFFIX)) {
                    const hasMetadata = await findAndReadMetadataFile(
                        fullPath,
                        allowedFileTypes,
                    );

                    if (hasMetadata) {
                        sdrFiles.push(fullPath);
                        devLog("Found valid SDR directory:", fullPath);
                    } else {
                        devWarn(`SDR directory missing metadata: ${fullPath}`);
                    }
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

        if (!isTableConstructor(returnValue)) {
            devError("Invalid return value type");
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

                const { key } = extractField(field);
                if (!key) continue;

                switch (key) {
                    case "doc_props": {
                        const extractedProps = extractDocProps(field);
                        result.docProps = {
                            // Maintain defaults but allow proper override
                            authors: extractedProps.authors ||
                                result.docProps.authors,
                            title: extractedProps.title ||
                                result.docProps.title,
                            description: extractedProps.description ||
                                result.docProps.description,
                            keywords: extractedProps.keywords ||
                                result.docProps.keywords,
                            series: extractedProps.series ||
                                result.docProps.series,
                            language: extractedProps.language ||
                                result.docProps.language,
                        };
                        break;
                    }
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
        devError("Error parsing Lua:", e.message, e.stack);
        return defaultResult;
    }
}

type LuaTableField = TableKey | TableKeyString | TableValue;

function extractField(
    field: LuaTableField,
): { key: string | number | null; value: ReturnType<typeof extractLuaValue> } {
    let key: string | number | null = null;
    let value: ReturnType<typeof extractLuaValue> = null;

    // Key extraction
    if (field.type === "TableKey" || field.type === "TableKeyString") {
        const keyField = field.key;
        if (keyField.type === "StringLiteral") {
            key = keyField.raw.replace(/^"(.*)"$/, "$1");
        } else if (keyField.type === "NumericLiteral") {
            key = keyField.value;
        } else if (keyField.type === "Identifier") {
            key = keyField.name;
        }
    }

    // Value extraction
    if (
        ["TableValue", "TableKey", "TableKeyString"].includes(field.type) &&
        isLuaValue(field.value)
    ) {
        value = extractLuaValue(field.value);
    }

    return { key: key ?? null, value: value ?? null };
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
                    const { key, value } = extractField(field);
                    if (key) {
                        acc[key.toString()] = value;
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

function createAnnotation(
    fields: LuaTableField[],
    options: { isLegacy: boolean } = { isLegacy: false },
): Annotation | null {
    const annotation: Annotation = {
        chapter: "",
        datetime: new Date().toISOString(),
        pageno: 0,
        text: "",
        note: undefined,  // Initialize note as undefined
    };

    for (const field of fields) {
        const { key, value } = extractField(field);
        if (!key || typeof key !== "string") continue;

        // Define field mappings for both modern and legacy formats
        const fieldMap: Record<string, keyof Annotation> = {
            [options.isLegacy ? "chapter_name" : "chapter"]: "chapter",
            [options.isLegacy ? "date" : "datetime"]: "datetime",
            [options.isLegacy ? "page" : "pageno"]: "pageno",
            text: "text",
            note: "note",    // Handle modern "note" field
            notes: "note",   // Handle legacy "notes" field
        };

        const targetField = fieldMap[key];
        if (!targetField || !(targetField in annotation)) continue;

        // Handle the field values based on their type
        if (typeof value === "string") {
            if (targetField === "pageno") {
                annotation.pageno = Number.parseInt(value, 10) || 0;
            } else if (targetField === "text" || targetField === "note") {
                annotation[targetField] = sanitizeString(value)
                    .replace(/\\\n/g, "\n\n")
                    .replace(/\\$/g, "\n\n");
            } else {
                annotation[targetField as Exclude<keyof Annotation, "pageno" | "note">] =
                    sanitizeString(value);
            }
        } else if (typeof value === "number" && targetField === "pageno") {
            annotation.pageno = value;
        }
    }

    // Return the annotation only if it has highlighted text
    return annotation.text ? annotation : null;
}

function extractModernAnnotation(field: LuaTableField): Annotation | null {
    if (!isTableConstructor(field.value)) return null;
    return createAnnotation(field.value.fields);
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
            const annotation = createAnnotation(highlightFields, {
                isLegacy: true,
            });
            if (annotation) annotations.push(annotation);
        }
    }
    //console.log(`Legacy Annotations: ${JSON.stringify(annotations)}`)
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
    allowedFileTypes: string[],
    frontmatterSettings: FrontmatterSettings,
    settings: KoReaderHighlightImporterSettings,
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
        metadata.docProps.title ??= fallbackName;
        metadata.docProps.authors ??= fallbackName;

        // 4. Conditional metadata fetching
        metadata.frontmatter = createFrontmatterData(
            metadata,
            frontmatterSettings,
        );

        try {
            const rootDir = path.parse(settings.koboMountPoint).root;
            const dbPath = path.join(
                rootDir,
                ".adds",
                "koreader",
                "settings",
                "statistics.sqlite3",
            );
            const stats = await getBookStatistics(
                dbPath,
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

function isTableValue(field: LuaTableField): field is TableValue {
    return field.type === "TableValue";
}

function isTableConstructor(
    node: Expression,
): node is TableConstructorExpression {
    return node.type === "TableConstructorExpression";
}
