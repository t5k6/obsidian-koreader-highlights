import luaparser from "luaparse";
import type {
    Expression,
    TableKey,
    TableKeyString,
    TableValue,
} from "luaparse/lib/ast";
import type {
    Annotation,
    DocProps,
    KoReaderHighlightImporterSettings,
    LuaMetadata,
} from "../types";
import { getFileNameWithoutExt } from "../utils/formatUtils";
import { devError, devLog, devWarn } from "../utils/logging";
import type { SDRFinder } from "./SDRFinder";

const parsedMetadataCache = new Map<string, LuaMetadata>();

const STRING_CACHE = new Map<string, string>();

// --- Helper: Clean and sanitize strings ---
function sanitizeString(rawValue: string): string {
    if (typeof rawValue !== "string") return "";

    const cached = STRING_CACHE.get(rawValue);
    if (cached) return cached;

    let cleaned = rawValue;
    cleaned = cleaned.trim();

    if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
    ) {
        cleaned = cleaned.slice(1, -1);
    }

    // 1. Specifically remove literal backslash followed by a newline character.
    //    This targets the "Author\<newline>" pattern.
    cleaned = cleaned.replace(/\\\n/g, "\n"); // Replace '\<newline>' with just '<newline>'

    // 2. Handle other known problematic encodings
    cleaned = cleaned.replace(/ΓÇö/g, "—");

    // 3. Handle standard Lua escape sequences (order matters)
    cleaned = cleaned.replace(/\\\\/g, "\\"); // MUST be before other single-backslash escapes if they can form from this
    cleaned = cleaned.replace(/\\"/g, '"');
    cleaned = cleaned.replace(/\\'/g, "'");
    cleaned = cleaned.replace(/\\n/g, "\n"); // For literal '\n' sequences
    cleaned = cleaned.replace(/\\t/g, "\t");
    cleaned = cleaned.replace(/\\r/g, "\r");
    // Any remaining single backslashes that are not part of a recognized escape
    // are often intended to be literal backslashes by Lua if they precede a non-alphanumeric char
    // or are at the end of a string. Our `replace(/\\\\/g, '\\')` handles the case
    // where a literal backslash was explicitly written as '\\' in Lua.
    // Lua string "a\z" -> a literal backslash then z. Lua string "a\\z" -> a literal backslash then z.

    if (STRING_CACHE.size > 2000) {
        STRING_CACHE.clear();
    }
    STRING_CACHE.set(rawValue, cleaned);

    return cleaned;
}

const DEFAULT_DOC_PROPS: DocProps = {
    authors: "",
    title: "",
    description: "",
    keywords: "",
    series: "",
    language: "en",
};

const DEFAULT_METADATA: Omit<LuaMetadata, "docProps"> = {
    pages: 0,
    annotations: [],
};

export class MetadataParser {
    constructor(
        private settings: KoReaderHighlightImporterSettings,
        private sdrFinder: SDRFinder,
    ) {}

    async parseFile(sdrDirectoryPath: string): Promise<LuaMetadata | null> {
        const cached = parsedMetadataCache.get(sdrDirectoryPath);
        if (cached) {
            devLog(`Using cached metadata for: ${sdrDirectoryPath}`);
            return cached;
        }

        devLog(`Parsing metadata for: ${sdrDirectoryPath}`);
        try {
            const luaContent = await this.sdrFinder.readMetadataFileContent(
                sdrDirectoryPath,
            );
            if (!luaContent) {
                devWarn(
                    `No metadata content found or readable in: ${sdrDirectoryPath}`,
                );
                return null;
            }

            const parsed = this.parseLuaContent(luaContent);

            const fullMetadata: LuaMetadata = {
                ...parsed,
                originalFilePath: sdrDirectoryPath,
            };

            if (
                !fullMetadata.docProps.authors && !fullMetadata.docProps.title
            ) {
                const fallbackName = getFileNameWithoutExt(sdrDirectoryPath);
                fullMetadata.docProps.authors = fallbackName;
                fullMetadata.docProps.title = fallbackName;
                devLog(`Applied fallback name "${fallbackName}" to metadata.`);
            }

            parsedMetadataCache.set(sdrDirectoryPath, parsed);
            return fullMetadata;
        } catch (error) {
            devError(
                `Error parsing metadata file in ${sdrDirectoryPath}:`,
                error,
            );
            return null;
        }
    }

    private parseLuaContent(luaContent: string): LuaMetadata {
        const result: Omit<LuaMetadata, "originalFilePath" | "statistics"> = { // Match initialization with what parseFile expects
            docProps: { ...DEFAULT_DOC_PROPS },
            pages: 0,
            annotations: [],
        };

        let hasProcessedModernAnnotations = false;
        let modernAnnotationsData: TableKey | null = null;
        let legacyHighlightData: TableKey | null = null;

        try {
            const ast = luaparser.parse(luaContent, {
                locations: false,
                comments: false,
            });

            if (
                !ast.body || ast.body.length === 0 ||
                ast.body[0].type !== "ReturnStatement"
            ) {
                devWarn(
                    "Invalid Lua structure: Expected top-level return statement.",
                );
                return result;
            }

            const returnArg = ast.body[0]
                .arguments![0] as luaparser.TableConstructorExpression;
            if (!returnArg || returnArg.type !== "TableConstructorExpression") {
                devWarn(
                    "Invalid Lua structure: Expected return statement to return a table.",
                );
                return result;
            }

            for (const field of returnArg.fields) {
                if (
                    field.type !== "TableKey" ||
                    field.key.type !== "StringLiteral"
                ) continue;
                const key = field.key.raw.slice(1, -1);

                switch (key) {
                    case "doc_props":
                        result.docProps = this.extractDocProps(field.value);
                        break;
                    case "doc_pages":
                        result.pages = this.extractNumericValue(field.value);
                        break;
                    case "annotations": // Modern
                        modernAnnotationsData = field;
                        break;
                    case "highlight": // Legacy
                        legacyHighlightData = field;
                        break;
                        // We will ignore "bookmarks" for highlight text extraction
                        // to avoid duplicates if they mirror "annotations" or "highlight".
                        // TODO: a feature for actual bookmark *locations* without text.
                }
            }

            // Second pass: Process annotations, prioritizing modern format
            let extractedAnnotations: Annotation[] = [];
            if (modernAnnotationsData) {
                devLog("Processing modern 'annotations' table.");
                extractedAnnotations = this.extractAnnotations(
                    modernAnnotationsData,
                    "modern",
                );
                if (extractedAnnotations.length > 0) {
                    hasProcessedModernAnnotations = true;
                }
            }

            // If no modern annotations were found (or the table was empty), try legacy format
            if (!hasProcessedModernAnnotations && legacyHighlightData) {
                devLog(
                    "No modern annotations found or they were empty, processing legacy 'highlight' table.",
                );
                extractedAnnotations = this.extractAnnotations(
                    legacyHighlightData,
                    "legacy",
                );
            }

            result.annotations = extractedAnnotations.filter(
                (a) => a?.text && a.text.trim() !== "",
            );

            devLog(
                `Parsed metadata with ${result.annotations.length} valid annotations. Modern processed: ${hasProcessedModernAnnotations}`,
            );
        } catch (error) {
            if (
                error instanceof Error && "line" in error && "column" in error
            ) {
                devError(
                    `Lua parsing error at Line ${error.line}, Column ${error.column}: ${error.message}`,
                    error.stack,
                );
            } else {
                devError("Error parsing Lua content:", error);
            }
            return result;
        }
        return result as LuaMetadata;
    }

    // --- Extraction Helper Functions ---

    private extractDocProps(valueNode: Expression): DocProps {
        const docProps = { ...DEFAULT_DOC_PROPS };
        if (valueNode.type !== "TableConstructorExpression") {
            return docProps;
        }

        for (const propField of valueNode.fields) {
            if (
                propField.type !== "TableKey" ||
                propField.key.type !== "StringLiteral"
            ) continue;

            const propKeyRaw = propField.key.raw.slice(1, -1); // e.g., "authors", "title"
            const propKey = propKeyRaw as keyof DocProps;

            let extractedValue = this.extractStringValue(propField.value);

            if (extractedValue !== null) {
                if (propKey === "keywords") {
                    extractedValue = extractedValue
                        .replace(/\\?\n/g, ", ")
                        .replace(/,\s*,/g, ",")
                        .trim();
                    devLog(`Processed keywords: "${extractedValue}"`);
                }

                if (propKey in docProps) {
                    (docProps as any)[propKey] = extractedValue;
                } else {
                    devWarn(`Unknown doc_prop key encountered: ${propKey}`);
                }
            } else {
                if (propKey in docProps) {
                    (docProps as any)[propKey] = DEFAULT_DOC_PROPS[propKey];
                }
            }
        }
        return docProps;
    }

    private extractAnnotations(
        field: TableKey,
        format: "modern" | "legacy",
    ): Annotation[] {
        if (field.value.type !== "TableConstructorExpression") return [];

        const annotations: Annotation[] = [];
        const keyName = field.key.type === "StringLiteral"
            ? field.key.raw.slice(1, -1)
            : "";

        if (format === "modern") {
            // Modern format: ["annotations"] = { [1] = {text="...", ...}, [2] = {...} }
            // Keys are numeric (or string representations of numbers) or items are just values in a list
            for (const entry of field.value.fields) {
                let annotationFields:
                    | Array<TableKey | TableKeyString | TableValue>
                    | undefined;
                if (
                    entry.type === "TableValue" &&
                    entry.value.type === "TableConstructorExpression"
                ) {
                    annotationFields = entry.value.fields;
                } else if (
                    entry.type === "TableKey" &&
                    entry.value.type === "TableConstructorExpression"
                ) {
                    // This handles cases like ["1"] = { ... }
                    annotationFields = entry.value.fields;
                }

                if (annotationFields) {
                    const annotation = this.createAnnotationFromFields(
                        annotationFields,
                    );
                    if (annotation) annotations.push(annotation);
                } else {
                    devWarn(
                        `Unexpected structure within 'annotations' table (modern format): ${entry.type}`,
                    );
                }
            }
        } else if (format === "legacy") {
            // Legacy format: ["highlight"] = { ["pageno_str"] = { ["idx_str"] = {text="...", ...} } }
            for (const pageField of field.value.fields) { // Iterates page number entries, e.g., ["71"]
                if (
                    pageField.type !== "TableKey" ||
                    pageField.value.type !== "TableConstructorExpression"
                ) continue;

                const pageNumStr = this.extractKeyAsString(pageField.key);
                const pageNum = pageNumStr
                    ? Number.parseInt(pageNumStr, 10)
                    : null;

                if (pageNum === null || Number.isNaN(pageNum)) {
                    devWarn(
                        `Invalid page number key in legacy 'highlight' table: ${pageNumStr}`,
                    );
                    continue;
                }

                // pageField.value is the table of highlights for that page, e.g., { ["1"] = {...} }
                for (const highlightGroupField of pageField.value.fields) { // Iterates highlight index entries, e.g., ["1"]
                    if (
                        highlightGroupField.type !== "TableKey" ||
                        highlightGroupField.value.type !==
                            "TableConstructorExpression"
                    ) continue;

                    const annotation = this.createAnnotationFromFields(
                        highlightGroupField.value.fields,
                    );
                    if (annotation) {
                        annotation.pageno = pageNum; // Assign the page number from the outer key
                        annotations.push(annotation);
                    }
                }
            }
        }
        return annotations;
    }

    private createAnnotationFromFields(
        fields: Array<TableKey | TableKeyString | TableValue>,
    ): Annotation | null {
        const annotation: Partial<Annotation> & { page?: number } = {};

        const fieldMap: Record<string, keyof Annotation | "page"> = {
            chapter: "chapter",
            chapter_name: "chapter",
            datetime: "datetime",
            date: "datetime",
            text: "text",
            notes: "note",
            note: "note",
            color: "color",
            draw_type: "drawer",
            drawer: "drawer",
            pageno: "page",
            page: "page",
            pos0: "pos0",
            pos1: "pos1",
        };

        const allowedDrawers: Annotation["drawer"][] = [
            "lighten",
            "underscore",
            "strikeout",
            "invert",
        ];

        for (const field of fields) {
            if (field.type !== "TableKey") continue;

            const key = this.extractKeyAsString(field.key);
            const targetField = key ? fieldMap[key] : null;

            if (targetField) {
                const valueNode = field.value; // AST Expression node
                switch (targetField) {
                    case "page": { // Also catches 'pageno' due to map
                        const pageNum = this.extractNumericValue(valueNode);
                        if (pageNum !== null) annotation.page = pageNum;
                        break;
                    }
                    case "drawer": {
                        const drawerVal = this.extractStringValue(valueNode)
                            ?.toLowerCase() as Annotation["drawer"];
                        if (drawerVal && allowedDrawers.includes(drawerVal)) {
                            annotation.drawer = drawerVal;
                        } else if (drawerVal) {
                            devWarn(
                                `Invalid/unhandled drawer value: ${drawerVal}`,
                            );
                        }
                        break;
                    }
                    case "text":
                    case "note": {
                        const extractedTextOrNote = this.extractStringValue(
                            valueNode,
                        );
                        annotation[targetField] = extractedTextOrNote ?? "";
                        break;
                    }
                    case "datetime":
                    // For all other mapped string fields (chapter, color, pos0, pos1)
                    // and datetime which is also extracted as a string initially.
                    default:
                        (annotation as any)[targetField] =
                            this.extractStringValue(valueNode) ?? undefined;
                        break;
                }
            } else if (key) {
                // devWarn(`Unknown annotation field key: ${key}`);
            }
        }

        // --- Post-processing for the annotation ---
        if (annotation.page !== undefined) {
            annotation.pageno = annotation.page;
            annotation.page = undefined;
        } else {
            annotation.pageno = 0;
        }

        // Validate essential fields
        if (!annotation.text || annotation.text.trim() === "") {
            return null;
        }
        if (!annotation.datetime) {
            annotation.datetime = new Date().toISOString();
            devWarn("Annotation missing datetime, using current time.");
        }
        if (!annotation.pos0 || !annotation.pos1) {
            devWarn(
                `Annotation for text "${
                    annotation.text.slice(0, 20)
                }..." missing pos0/pos1.`,
            );
        }

        return annotation as Annotation;
    }
    // --- Primitive Value Extractors ---

    private extractKeyAsString(keyNode: Expression): string | null {
        if (keyNode.type === "StringLiteral") {
            return keyNode.raw.slice(1, -1); // Remove quotes
        }
        if (keyNode.type === "NumericLiteral") {
            return keyNode.value.toString();
        }
        if (keyNode.type === "Identifier") {
            return keyNode.name;
        }
        devWarn(`Cannot extract string key from node type: ${keyNode.type}`);
        return null;
    }

    private extractStringValue(valueNode: Expression): string | null {
        if (valueNode.type === "StringLiteral") {
            const sanitized = sanitizeString(valueNode.raw);
            return sanitized;
        }
        // Handle numbers/booleans being represented as strings if necessary
        if (valueNode.type === "NumericLiteral") {
            return valueNode.value.toString();
        }
        if (valueNode.type === "BooleanLiteral") {
            return valueNode.value.toString();
        }
        // devWarn(`Expected StringLiteral, got ${valueNode.type}`);
        return null;
    }

    private extractNumericValue(valueNode: Expression): number | null {
        if (valueNode.type === "NumericLiteral") {
            return valueNode.value;
        }
        if (valueNode.type === "StringLiteral") {
            const num = Number.parseFloat(sanitizeString(valueNode.raw));
            if (!Number.isNaN(num)) return num;
        }
        // devWarn(`Expected NumericLiteral, got ${valueNode.type}`);
        return null;
    }

    clearCache(): void {
        parsedMetadataCache.clear();
        STRING_CACHE.clear();
        devLog("MetadataParser cache cleared.");
    }
}
