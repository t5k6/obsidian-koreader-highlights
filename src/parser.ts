import { readdir, readFile, stat } from "node:fs/promises";
import { join as node_join } from "node:path";
import type { App } from "obsidian";
import type { Annotation, DocProps, Field, LuaMetadata } from "./types";
const luaparser = require("luaparse");

export async function findSDRFiles(
    rootDir: string,
    excludedFolders: string[],
    allowedFileTypes: string[],
): Promise<string[]> {
    const sdrFiles: string[] = [];
    console.log("findSDRFiles called with rootDir:", rootDir);

    async function traverseDir(directory: string) {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (readDirError) {
            const error = readDirError as NodeJS.ErrnoException;
            if (error.code === "ENOENT") {
                console.error(
                    `Directory not found: ${directory}`,
                );
            } else if (error.code === "EPERM") {
                console.error(
                    `Permission denied for directory: ${directory}`,
                );
            } else {
                console.error(
                    `Error reading directory ${directory}:`,
                    error,
                );
            }
            return;
        }

        for (const entry of entries) {
            const fullPath = node_join(directory, entry.name);

            if (excludedFolders.includes(entry.name)) continue;

            if (entry.isDirectory() && entry.name.endsWith(".sdr")) {
                if (await hasAllowedMetadataFile(fullPath, allowedFileTypes)) {
                    sdrFiles.push(fullPath);
                    console.log("Found SDR directory:", fullPath);
                } else if (allowedFileTypes.length > 0) {
                    console.warn(
                        `No matching metadata file found in ${fullPath}. Allowed file types were ${allowedFileTypes}.`,
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
    console.log("All found sdrFiles:", sdrFiles);
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
                // Corrected regular expression:
                const match = file.match(/^metadata\.\w+\.lua$/); // Match "metadata." followed by one or more characters, then ".lua"
                if (match) {
                    const metadataPath = node_join(directory, file);
                    if ((await stat(metadataPath)).isFile()) return true;
                }
            }
            // No metadata file found
            return false;
        } catch (error) {
            console.error(`Error reading directory ${directory}:`, error);
            return false;
        }
    } else {
        // Check for specific file types (no changes needed here)
        for (const fileType of allowedFileTypes) {
            const metadataPath = node_join(
                directory,
                `metadata.${fileType}.lua`,
            );
            try {
                if ((await stat(metadataPath)).isFile()) return true;
            } catch (metadataError) {
                const error = metadataError as NodeJS.ErrnoException;
                if (error.code === "ENOENT") {
                    console.warn(`Metadata file not found: ${metadataPath}`);
                } else if (error.code === "EPERM") {
                    console.error(
                        `Permission denied for file: ${metadataPath}`,
                    );
                } else {
                    console.error(
                        `Error checking metadata in ${directory}:`,
                        error,
                    );
                }
            }
        }
        return false;
    }
}

function extractDocProps(field: Field): DocProps {
    const docProps: DocProps = {
        authors: "",
        title: "",
        description: "",
        keywords: "",
        series: "",
        language: "en",
    };

    if (field.value.type !== "TableConstructorExpression") return docProps;

    for (const subField of field.value.fields) {
        if (
            subField.type !== "TableKey" ||
            subField.key.type !== "StringLiteral"
        ) continue;
        const subKey = subField.key.raw.replace(/^"(.*)"$/, "$1");

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
                console.warn(
                    `Unhandled value type for doc_prop '${subKey}': ${subField.value.type}`,
                );
            }

            (docProps as any)[subKey] = value;
        } else {
            console.warn(`Unknown doc_prop key: ${subKey}`);
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
        //console.log("Parsed AST:", JSON.stringify(ast, null, 2));

        if (!ast.body?.[0] || ast.body[0].type !== "ReturnStatement") {
            console.error("Invalid Lua structure: No return statement found");
            return defaultResult;
        }

        const returnValue = ast.body[0].arguments?.[0];
        if (!returnValue) {
            console.error("Invalid Lua structure: No return value found");
            return defaultResult;
        }

        const result: LuaMetadata = { ...defaultResult };
        let creDomVersion: number | null = null;

        if (returnValue.type === "TableConstructorExpression") {
            for (const field of returnValue.fields) {
                if (field.type !== "TableKey") {
                    console.warn(`Skipping non-table key field: ${field.type}`);
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
                        creDomVersion = extractVersionNumber(field.value);
                        break;
                    case "doc_pages":
                        result.pages = extractVersionNumber(field.value);
                        break;
                    case "annotations":
                    case "highlight": {
                        const extractedAnnotations = extractAnnotations(
                            field,
                            creDomVersion,
                        );
                        if (extractedAnnotations.length > 0) {
                            result.annotations = extractedAnnotations;
                        }
                        break;
                    }
                    default:
                        //console.log(`Unhandled key: ${key}`);
                        continue;
                }
            }
        }
        console.log("Parsed result:", result);
        return result;
    } catch (error) {
        const e = error as Error;
        console.error("Error parsing Lua:", e.message);
        return defaultResult;
    }
}

function extractKeyFromField(field: any): string | null {
    if (!field.key) return null;

    if (field.key.type === "StringLiteral") {
        return field.key.raw.replace(/^"(.*)"$/, "$1");
    } else if (field.key.type === "Identifier") {
        return field.key.name;
    }

    console.warn(`Unexpected key type: ${field.key.type}`);
    return null;
}

function extractVersionNumber(value: any): number | null {
    if (value.type === "NumericLiteral") {
        return value.value;
    }
    if (value.type === "StringLiteral") {
        return Number.parseInt(value.value, 10);
    }
    return null;
}

function extractValue(value: any): any {
    if (!value) return null;

    switch (value.type) {
        case "StringLiteral":
            return value.raw.replace(/^"(.*)"$/, "$1").replace(/\\n/g, "\n");
        case "NumericLiteral":
            return value.value;
        case "BooleanLiteral":
            return value.value;
        case "TableConstructorExpression":
            return value.fields.reduce((acc: any, field: any) => {
                const key = extractKeyFromField(field);
                if (key) {
                    acc[key] = extractValue(field.value);
                }
                return acc;
            }, {});
        default:
            console.warn(`Unhandled value type: ${value.type}`);
            return null;
    }
}

function extractAnnotations(
    field: any,
    creDomVersion: number | null,
): Annotation[] {
    console.log(`Extracting annotations for version ${creDomVersion}`);

    if (field.value.type !== "TableConstructorExpression") {
        console.warn("Invalid annotations table structure");
        return [];
    }

    const annotations: Annotation[] = [];

    // Handle modern format (post-2024)
    if (field.key.raw.includes("annotations")) {
        for (const entry of field.value.fields) {
            const annotation = extractModernAnnotation(entry);
            if (annotation) annotations.push(annotation);
        }
    } // Handle legacy format (pre-2024)
    else if (field.key.raw.includes("highlight")) {
        for (const pageField of field.value.fields) {
            const pageAnnotations = extractLegacyAnnotations(pageField);
            annotations.push(...pageAnnotations);
        }
    }

    return annotations;
}

function extractModernAnnotation(entry: Field): Annotation | null {
    if (entry.value.type !== "TableConstructorExpression") return null;

    const annotation: Annotation = {
        chapter: "",
        datetime: "",
        pageno: 0,
        text: "",
    };

    for (const field of entry.value.fields) {
        const key = extractKeyFromField(field);
        if (!key) continue;

        const value = extractValue(field.value);
        switch (key) {
            case "chapter":
                annotation.chapter = value || "";
                break;
            case "datetime":
                annotation.datetime = value || "";
                break;
            case "pageno":
                annotation.pageno = typeof value === "number" ? value : 0;
                break;
            case "text":
                annotation.text = value || "";
                break;
        }
    }

    return annotation;
}

function extractLegacyAnnotations(pageField: any): Annotation[] {
    const annotations: Annotation[] = [];
    const pageNumber = extractValue(pageField.key);

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

            const value = extractValue(field.value);
            switch (key) {
                case "chapter":
                    annotation.chapter = value || "";
                    break;
                case "datetime":
                    annotation.datetime = value || "";
                    break;
                case "text":
                    annotation.text = value || "";
                    break;
            }
        }

        annotations.push(annotation);
    }

    return annotations;
}

export async function readSDRFileContent(
    filePath: string,
    allowedFileTypes: string[] = [],
    app: App,
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
                        console.warn(`Skipping non-file: ${luaFilePath}`);
                        continue;
                    }
                    console.log(`File found: ${luaFilePath}`);
                    const content = await readFile(luaFilePath, "utf-8");
                    return parseHighlights(content);
                }
            }
        } catch (error) {
            const e = error as NodeJS.ErrnoException;
            if (e.code === "ENOENT") {
                console.warn(`Directory not found: ${filePath}`);
            } else if (e.code === "EPERM") {
                console.error(`Permission denied for directory: ${filePath}`);
            } else {
                console.error(
                    `Error reading directory ${filePath}:`,
                    e.message,
                );
            }
        }
    } else {
        for (const fileType of allowedFileTypes) {
            const luaFilePath = node_join(filePath, `metadata.${fileType}.lua`);
            try {
                const stats = await stat(luaFilePath);
                if (!stats.isFile()) {
                    console.warn(`Skipping non-file: ${luaFilePath}`);
                    continue;
                }
                console.log(`File found: ${luaFilePath}`);
                const content = await readFile(luaFilePath, "utf-8");
                return parseHighlights(content);
            } catch (error) {
                const e = error as NodeJS.ErrnoException;
                if (e.code === "ENOENT") {
                    console.warn(`File not found: ${luaFilePath}`);
                } else if (e.code === "EPERM") {
                    console.error(`Permission denied for file: ${luaFilePath}`);
                } else {
                    console.error(
                        `Error reading file ${luaFilePath}:`,
                        e.message,
                    );
                }
            }
        }
    }

    console.error(
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
