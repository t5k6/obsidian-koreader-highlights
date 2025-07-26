import luaparser from "luaparse";
import type {
	Expression,
	TableKey,
	TableKeyString,
	TableValue,
} from "luaparse/lib/ast";
import type { CacheManager } from "src/utils/cache/CacheManager";
import { LruCache } from "src/utils/cache/LruCache";
import { createLogger, logger } from "src/utils/logging";
import {
	type Annotation,
	type DocProps,
	DRAWER_TYPES,
	type LuaMetadata,
} from "../types";
import type { SDRFinder } from "./SDRFinder";

const log = createLogger("MetadataParser");
const parsedMetadataCache = new LruCache<string, LuaMetadata>(50);
const STRING_CACHE = new LruCache<string, string>(2000);

const DEFAULT_DOC_PROPS: DocProps = {
	authors: "",
	title: "",
	description: "",
	keywords: "",
	series: "",
	language: "en",
};

export class MetadataParser {
	private parsedMetadataCache: LruCache<string, LuaMetadata>;
	private stringCache: LruCache<string, string>;

	constructor(
		private sdrFinder: SDRFinder,
		private cacheManager: CacheManager,
	) {
		this.parsedMetadataCache = cacheManager.createLru("metadata.parsed", 50);
		this.stringCache = cacheManager.createLru("metadata.strings", 2000);
	}

	async parseFile(sdrDirectoryPath: string): Promise<LuaMetadata | null> {
		const cached = parsedMetadataCache.get(sdrDirectoryPath);
		if (cached) {
			logger.info(
				`MetadataParser: Using cached metadata for: ${sdrDirectoryPath}`,
			);
			return cached;
		}

		logger.info(`MetadataParser: Parsing metadata for: ${sdrDirectoryPath}`);
		try {
			const luaContent =
				await this.sdrFinder.readMetadataFileContent(sdrDirectoryPath);
			if (!luaContent) {
				logger.warn(
					`MetadataParser: No metadata content found or readable in: ${sdrDirectoryPath}`,
				);
				return null;
			}

			const parsedBase = this.parseLuaContent(luaContent);

			const fullMetadata: LuaMetadata = {
				...parsedBase,
				originalFilePath: sdrDirectoryPath,
			};

			parsedMetadataCache.set(sdrDirectoryPath, fullMetadata);
			return fullMetadata;
		} catch (error) {
			logger.error(
				`MetadataParser: Error parsing metadata file in ${sdrDirectoryPath}:`,
				error,
			);
			return null;
		}
	}

	private collectAnnotations(
		node: luaparser.TableConstructorExpression,
		pageOverride?: number,
	): Annotation[] {
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
						out.push(...this.collectAnnotations(annotationNode, pageNum));
					}
				}
			}
		}
		return out;
	}

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
				logger.warn(
					"MetadataParser: Invalid Lua structure: Expected top-level return statement.",
				);
				return result;
			}

			const returnArg = ast.body[0]
				.arguments![0] as luaparser.TableConstructorExpression;
			if (!returnArg || returnArg.type !== "TableConstructorExpression") {
				logger.warn(
					"MetadataParser: Invalid Lua structure: Expected return statement to return a table.",
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
				log.info("Processing modern 'annotations' table.");
				annotations = this.collectAnnotations(modernAnnotationsData.value);
			}

			// 2. If no modern annotations were found, fall back to the legacy 'highlight' table.
			if (
				annotations.length === 0 &&
				legacyHighlightData?.value.type === "TableConstructorExpression"
			) {
				log.info(
					"No modern annotations found. Processing legacy 'highlight' table.",
				);
				annotations = this.collectAnnotations(legacyHighlightData.value);
			}

			// 3. Filter out any annotations that might be empty.
			result.annotations = annotations.filter((a) => a.text?.trim());

			log.info(`Parsed ${result.annotations.length} valid annotation(s).`);
			return result;
		} catch (error) {
			if (error instanceof Error && "line" in error && "column" in error) {
				logger.error(
					`MetadataParser: Lua parsing error at Line ${(error as any).line}, Column ${(error as any).column}: ${error.message}`,
					error.stack,
				);
			} else {
				logger.error("MetadataParser: Error parsing Lua content:", error);
			}
			throw error; // Re-throw the error for parseFile to catch and return null
		}
	}

	// --- Extraction Helper Functions ---

	private extractDocProps(valueNode: Expression): DocProps {
		const docProps = { ...DEFAULT_DOC_PROPS };
		if (valueNode.type !== "TableConstructorExpression") {
			logger.warn("MetadataParser: doc_props was not a table, using defaults.");
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
					// logger.warn(`MetadataParser: Unknown doc_prop key encountered: ${propKey}`);
				}
			} // If extractedValue is null, the default from DEFAULT_DOC_PROPS remains
		}
		return docProps;
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

		for (const field of fields) {
			if (field.type !== "TableKey") continue;
			const key = this.extractKeyAsString(field.key);
			const targetField = key ? fieldMap[key] : null;
			if (!targetField) continue;

			const valueNode = field.value;
			switch (targetField) {
				case "page": {
					const pageNumVal = this.extractNumericValue(valueNode);
					if (pageNumVal !== null) annotation.page = pageNumVal;
					break;
				}
				case "drawer": {
					const drawerVal = this.extractStringValue(valueNode)?.toLowerCase();
					if (
						drawerVal &&
						(DRAWER_TYPES as readonly string[]).includes(drawerVal)
					) {
						annotation.drawer = drawerVal as any;
					} else if (drawerVal) {
						logger.warn(
							`MetadataParser: Invalid/unhandled drawer value: ${drawerVal}`,
						);
					}
					break;
				}
				case "text":
				case "note":
					annotation[targetField] = this.extractStringValue(valueNode) ?? "";
					break;
				default:
					(annotation as any)[targetField] =
						this.extractStringValue(valueNode) ?? undefined;
					break;
			}
		}

		if (annotation.page !== undefined) {
			annotation.pageno = annotation.page;
			delete annotation.page;
		} else {
			annotation.pageno = 0;
		}

		if (!annotation.text || annotation.text.trim() === "") return null;
		if (!annotation.datetime) {
			annotation.datetime = new Date().toISOString();
			logger.warn(
				`MetadataParser: Annotation missing datetime, using current time.`,
			);
		}
		if (!annotation.pos0 || !annotation.pos1) {
			logger.info(
				`MetadataParser: Annotation for text "${annotation.text.slice(
					0,
					20,
				)}..." missing pos0/pos1.`,
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
		logger.warn(
			`MetadataParser: Cannot extract string key from node type: ${keyNode.type}`,
		);
		return null;
	}

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
		cleaned = cleaned.replace(/ΓÇö/g, "—");
		cleaned = cleaned.replace(/\\\\/g, "\\");
		cleaned = cleaned.replace(/\\"/g, '"');
		cleaned = cleaned.replace(/\\'/g, "'");
		cleaned = cleaned.replace(/\\n/g, "\n");
		cleaned = cleaned.replace(/\\t/g, "\t");
		cleaned = cleaned.replace(/\\r/g, "\r");

		this.stringCache.set(rawValue, cleaned);
		return cleaned;
	}

	private extractStringValue(valueNode: Expression): string | null {
		if (valueNode.type === "StringLiteral") {
			const sanitized = this.sanitizeString(valueNode.raw);
			return sanitized;
		}
		// Handle numbers/booleans being represented as strings if necessary
		if (valueNode.type === "NumericLiteral") {
			return valueNode.value.toString();
		}
		if (valueNode.type === "BooleanLiteral") {
			return valueNode.value.toString();
		}
		// logger.warn(`Expected StringLiteral, got ${valueNode.type}`);
		return null;
	}

	private extractNumericValue(valueNode: Expression): number | null {
		if (valueNode.type === "NumericLiteral") {
			return valueNode.value;
		}
		if (valueNode.type === "StringLiteral") {
			const num = Number.parseFloat(this.sanitizeString(valueNode.raw));
			if (!Number.isNaN(num)) return num;
		}
		// logger.warn(`Expected NumericLiteral, got ${valueNode.type}`);
		return null;
	}

	clearCache(): void {
		parsedMetadataCache.clear();
		STRING_CACHE.clear();
		logger.info("MetadataParser: Caches cleared.");
	}
}
