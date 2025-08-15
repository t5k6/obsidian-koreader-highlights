import { createHash } from "node:crypto";
import luaparser from "luaparse";
import type {
	Expression,
	TableKey,
	TableKeyString,
	TableValue,
} from "luaparse/lib/ast";
import type { CacheManager } from "src/lib/cache/CacheManager";
import type { LruCache } from "src/lib/cache/LruCache";
import type { SDRFinder } from "src/services/device/SDRFinder";
import {
	type Annotation,
	type DocProps,
	DRAWER_TYPES,
	type LuaMetadata,
} from "src/types";
import type { LoggingService } from "../LoggingService";
import { FieldMappingService } from "./FieldMappingService";

const DEFAULT_DOC_PROPS: DocProps = {
	authors: "",
	title: "",
	description: "",
	keywords: "",
	series: "",
	language: "en",
};

export class MetadataParser {
	private readonly log;
	private parsedMetadataCache: LruCache<string, LuaMetadata>;
	private stringCache: LruCache<string, string>;

	constructor(
		private sdrFinder: SDRFinder,
		cacheManager: CacheManager,
		private loggingService: LoggingService,
	) {
		this.parsedMetadataCache = cacheManager.createLru("metadata.parsed", 50);
		this.stringCache = cacheManager.createLru("metadata.strings", 2000);
		this.log = this.loggingService.scoped("MetadataParser");
	}

	/**
	 * Parses a KOReader metadata.lua file from an SDR directory.
	 * Uses caching to avoid re-parsing the same files.
	 * @param sdrDirectoryPath - Path to the SDR directory containing metadata.lua
	 * @returns Parsed metadata object or null if parsing fails
	 */
	async parseFile(sdrDirectoryPath: string): Promise<LuaMetadata | null> {
		this.log.info(`Parsing metadata for: ${sdrDirectoryPath}`);
		try {
			const luaContent =
				await this.sdrFinder.readMetadataFileContent(sdrDirectoryPath);
			if (!luaContent) {
				this.log.warn(
					`No metadata content found or readable in: ${sdrDirectoryPath}`,
				);
				return null;
			}

			// Use a content-based cache key to avoid stale caching across sessions/updates
			const contentHash = createHash("sha1").update(luaContent).digest("hex");
			const cacheKey = `${sdrDirectoryPath}::${contentHash}`;
			const cachedByContent = this.parsedMetadataCache.get(cacheKey);
			if (cachedByContent) {
				this.log.info(
					`Using cached parsed metadata (content match) for: ${sdrDirectoryPath}`,
				);
				return cachedByContent;
			}

			const parsedBase = this.parseLuaContent(luaContent);

			const fullMetadata: LuaMetadata = {
				...parsedBase,
				originalFilePath: sdrDirectoryPath,
			};

			this.parsedMetadataCache.set(cacheKey, fullMetadata);
			return fullMetadata;
		} catch (error) {
			this.log.error(
				`Error parsing metadata file in ${sdrDirectoryPath}:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Recursively collects annotations from a Lua table structure.
	 * Handles both modern format and legacy page-keyed format.
	 * @param node - Table constructor expression containing annotations
	 * @param pageOverride - Page number to use for nested annotations
	 * @returns Array of parsed annotations
	 */
	private collectAnnotations(
		node: luaparser.TableConstructorExpression,
		pageOverride?: number,
		depth = 0,
	): Annotation[] {
		if (depth > 10) {
			this.log.warn("Annotation nesting too deep, stopping recursion");
			return [];
		}

		const out: Annotation[] = [];

		for (const field of node.fields) {
			let annotationNode: luaparser.TableConstructorExpression | null = null;

			// Check if the field itself is a table containing an annotation
			if (
				(field.type === "TableValue" || field.type === "TableKey") &&
				field.value.type === "TableConstructorExpression"
			) {
				annotationNode = field.value;
			}

			if (annotationNode) {
				// This node could be an annotation OR a page-keyed table in the legacy format.
				// First, try to parse it as a single annotation.
				const ann = this.createAnnotationFromFields(annotationNode.fields);

				if (ann?.text?.trim()) {
					// A valid annotation must have text
					if (pageOverride !== undefined) {
						ann.pageno = pageOverride;
					}
					out.push(ann);
				} else if (pageOverride === undefined && field.type === "TableKey") {
					// If it wasn't a valid annotation, it might be a legacy page-keyed table.
					// We only do this check at the top level (no pageOverride).
					const pageNumStr = this.extractKeyAsString(field.key);
					const pageNum = pageNumStr ? Number(pageNumStr) : NaN;

					if (Number.isFinite(pageNum)) {
						// It's a page number. Recurse into its value.
						out.push(
							...this.collectAnnotations(annotationNode, pageNum, depth + 1),
						);
					}
				}
			}
		}
		return out;
	}

	/**
	 * Parses the raw Lua content into structured metadata.
	 * Handles AST parsing and extracts document properties and annotations.
	 * @param luaContent - Raw Lua file content
	 * @returns Parsed metadata without file path and statistics
	 */
	private parseLuaContent(
		luaContent: string,
	): Omit<LuaMetadata, "originalFilePath" | "statistics"> {
		const result: Omit<LuaMetadata, "originalFilePath" | "statistics"> = {
			docProps: { ...DEFAULT_DOC_PROPS },
			pages: 0,
			annotations: [],
			md5: undefined,
		};

		try {
			const ast = luaparser.parse(luaContent, {
				locations: false,
				comments: false,
			});

			if (
				!ast.body ||
				ast.body.length === 0 ||
				ast.body[0].type !== "ReturnStatement"
			) {
				this.log.warn(
					"Invalid Lua structure: Expected top-level return statement.",
				);
				return result;
			}

			const returnArg = ast.body[0]
				.arguments![0] as luaparser.TableConstructorExpression;
			if (!returnArg || returnArg.type !== "TableConstructorExpression") {
				this.log.warn(
					"Invalid Lua structure: Expected return statement to return a table.",
				);
				return result;
			}

			let modernAnnotationsData: luaparser.TableKey | null = null;
			let legacyHighlightData: luaparser.TableKey | null = null;

			for (const field of returnArg.fields) {
				if (field.type !== "TableKey" || field.key.type !== "StringLiteral")
					continue;
				const key = field.key.raw.slice(1, -1);

				switch (key) {
					case "doc_props":
						result.docProps = this.extractDocProps(field.value);
						break;
					case "doc_pages":
						result.pages = this.extractNumericValue(field.value) ?? 0;
						break;
					case "partial_md5_checksum":
						result.md5 = this.extractStringValue(field.value) ?? undefined;
						break;
					case "annotations":
						modernAnnotationsData = field;
						break;
					case "highlight":
						legacyHighlightData = field;
						break;
				}
			}

			let annotations: Annotation[] = [];

			// 1. Try to process the modern 'annotations' table first.
			if (modernAnnotationsData?.value.type === "TableConstructorExpression") {
				this.log.info("Processing modern 'annotations' table.");
				annotations = this.collectAnnotations(modernAnnotationsData.value);
			}

			// 2. If no modern annotations were found, fall back to the legacy 'highlight' table.
			if (
				annotations.length === 0 &&
				legacyHighlightData?.value.type === "TableConstructorExpression"
			) {
				this.log.info(
					"No modern annotations found. Processing legacy 'highlight' table.",
				);
				annotations = this.collectAnnotations(legacyHighlightData.value);
			}

			// 3. Filter out any annotations that might be empty.
			result.annotations = annotations.filter((a) => a.text?.trim());

			this.log.info(`Parsed ${result.annotations.length} valid annotation(s).`);
			return result;
		} catch (error: unknown) {
			const e = error as Partial<Error> & {
				line?: number;
				column?: number;
				stack?: string;
			};
			if (
				e &&
				typeof e.line === "number" &&
				typeof e.column === "number" &&
				e.message
			) {
				this.log.error(
					`Lua parsing error at Line ${e.line}, Column ${e.column}: ${e.message}`,
					e.stack,
				);
			} else {
				this.log.error("Error parsing Lua content:", error);
			}
			throw error as unknown; // rethrow for caller
		}
	}

	// --- Extraction Helper Functions ---

	/**
	 * Extracts document properties from a Lua table node.
	 * @param valueNode - AST node representing the doc_props table
	 * @returns Document properties with defaults applied
	 */
	private extractDocProps(valueNode: Expression): DocProps {
		const docProps = { ...DEFAULT_DOC_PROPS };
		if (valueNode.type !== "TableConstructorExpression") {
			this.log.warn("doc_props was not a table, using defaults.");
			return docProps;
		}

		for (const propField of valueNode.fields) {
			if (
				propField.type !== "TableKey" ||
				propField.key.type !== "StringLiteral"
			)
				continue;
			const propKeyRaw = propField.key.raw.slice(1, -1);
			const propKey = propKeyRaw as keyof DocProps;
			let extractedValue = this.extractStringValue(propField.value);

			if (extractedValue !== null) {
				if (propKey === "keywords") {
					extractedValue = extractedValue
						.replace(/\\?\n/g, ", ")
						.replace(/,\s*,/g, ",")
						.trim();
				}
				if (propKey in docProps) {
					// Check against known DocProps keys
					(docProps as any)[propKey] = extractedValue;
				} else {
					// Optional: log unknown keys if you want to detect them
				}
			} // If extractedValue is null, the default from DEFAULT_DOC_PROPS remains
		}
		return docProps;
	}

	/**
	 * Creates an annotation object from Lua table fields.
	 * Maps various field names to standardized annotation properties using FieldMappingService.
	 */
	private createAnnotationFromFields(
		fields: Array<TableKey | TableKeyString | TableValue>,
	): Annotation | null {
		const annotation: Partial<Annotation> & { page?: number } = {};

		const set = <K extends keyof Annotation>(
			k: K,
			v: Annotation[K] | undefined,
		) => {
			if (v !== undefined) annotation[k] = v;
		};

		for (const field of fields) {
			if (field.type !== "TableKey") continue;
			const key = this.extractKeyAsString(field.key);
			const mapped = key ? FieldMappingService.fromLua(key) : null;
			const targetField: (keyof Annotation | "page") | null =
				mapped === "page" ? "page" : ((mapped as keyof Annotation) ?? null);
			if (!targetField) continue;

			const valueNode = field.value;
			switch (targetField) {
				case "page": {
					const pageNumVal = this.extractNumericValue(valueNode);
					if (pageNumVal !== null)
						(annotation as { page?: number }).page = pageNumVal;
					break;
				}
				case "drawer": {
					const drawerVal = this.extractStringValue(valueNode)?.toLowerCase();
					if (
						drawerVal &&
						(DRAWER_TYPES as readonly string[]).includes(drawerVal)
					) {
						set("drawer", drawerVal as (typeof DRAWER_TYPES)[number]);
					} else if (drawerVal) {
						this.log.warn(`Invalid/unhandled drawer value: ${drawerVal}`);
					}
					break;
				}
				case "text":
				case "note": {
					const s = this.extractStringValue(valueNode);
					set(targetField as keyof Annotation, (s ?? "") as any);
					break;
				}
				default: {
					const s = this.extractStringValue(valueNode) ?? undefined;
					set(targetField as keyof Annotation, s as any);
					break;
				}
			}
		}

		if ((annotation as { page?: number }).page !== undefined) {
			annotation.pageno = (annotation as { page?: number }).page;
			delete (annotation as { page?: number }).page;
		} else {
			annotation.pageno = 0;
		}

		if (!annotation.text || annotation.text.trim() === "") return null;
		if (!annotation.datetime) {
			annotation.datetime = new Date().toISOString();
			this.log.warn(`Annotation missing datetime, using current time.`);
		}
		if (!annotation.pos0 || !annotation.pos1) {
			this.log.info(
				`Annotation for text "${annotation.text.slice(0, 20)}..." missing pos0/pos1.`,
			);
		}
		return annotation as Annotation;
	}
	// --- Primitive Value Extractors ---

	/**
	 * Extracts a string representation from various AST key node types.
	 * @param keyNode - AST node representing a table key
	 * @returns String value or null if extraction fails
	 */
	private extractKeyAsString(keyNode: Expression): string | null {
		switch (keyNode.type) {
			case "StringLiteral":
				return keyNode.raw.slice(1, -1);
			case "NumericLiteral":
				return keyNode.value.toString();
			case "Identifier":
				return keyNode.name;
			default:
				this.log.warn(
					`Cannot extract string key from node type: ${keyNode.type}`,
				);
				return null;
		}
	}

	/**
	 * Sanitizes and unescapes string values from Lua.
	 * Handles quote removal and escape sequences.
	 * Uses caching for performance.
	 * @param rawValue - Raw string from Lua parser
	 * @returns Cleaned and unescaped string
	 */
	private sanitizeString(rawValue: string): string {
		if (typeof rawValue !== "string") return "";
		const cached = this.stringCache.get(rawValue);
		if (cached) return cached;
		let cleaned = rawValue.trim();
		if (
			(cleaned.startsWith('"') && cleaned.endsWith('"')) ||
			(cleaned.startsWith("'") && cleaned.endsWith("'"))
		) {
			cleaned = cleaned.slice(1, -1);
		}
		cleaned = cleaned.replace(/\\(.)/g, (match, char) => {
			const escapeMap: Record<string, string> = {
				n: "\n",
				t: "\t",
				r: "\r",
				'"': '"',
				"'": "'",
				"\\": "\\",
			};
			return escapeMap[char] || match;
		});

		this.stringCache.set(rawValue, cleaned);
		return cleaned;
	}

	/**
	 * Extracts a string value from various AST node types.
	 * @param valueNode - AST node to extract string from
	 * @returns String value or null if extraction fails
	 */
	private extractStringValue(valueNode: Expression): string | null {
		switch (valueNode.type) {
			case "StringLiteral":
				return this.sanitizeString(valueNode.raw);
			case "NumericLiteral":
				return valueNode.value.toString();
			case "BooleanLiteral":
				return valueNode.value.toString();
			default:
				return null;
		}
	}

	/**
	 * Extracts a numeric value from various AST node types.
	 * @param valueNode - AST node to extract number from
	 * @returns Numeric value or null if extraction fails
	 */
	private extractNumericValue(valueNode: Expression): number | null {
		switch (valueNode.type) {
			case "NumericLiteral":
				return valueNode.value;
			case "StringLiteral": {
				const num = Number.parseFloat(this.sanitizeString(valueNode.raw));
				return Number.isNaN(num) ? null : num;
			}
			default:
				return null;
		}
	}
}
