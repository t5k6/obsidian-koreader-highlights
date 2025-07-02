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
	KoreaderHighlightImporterSettings,
	LuaMetadata,
} from "../types";
import { devError, devLog, devWarn } from "../utils/logging";
import type { SDRFinder } from "./SDRFinder";

const parsedMetadataCache = new Map<string, LuaMetadata>();

const STRING_CACHE = new Map<string, string>();

// --- Helper: Clean and sanitize strings ---
function sanitizeString(rawValue: string): string {
	if (typeof rawValue !== "string") return "";
	const cached = STRING_CACHE.get(rawValue);
	if (cached) return cached;
	let cleaned = rawValue.trim();
	if (
		(cleaned.startsWith('"') && cleaned.endsWith('"')) ||
		(cleaned.startsWith("'") && cleaned.endsWith("'"))
	) {
		cleaned = cleaned.slice(1, -1);
	}
	cleaned = cleaned.replace(/\\\n/g, "\n");
	cleaned = cleaned.replace(/ΓÇö/g, "—");
	cleaned = cleaned.replace(/\\\\/g, "\\");
	cleaned = cleaned.replace(/\\"/g, '"');
	cleaned = cleaned.replace(/\\'/g, "'");
	cleaned = cleaned.replace(/\\n/g, "\n");
	cleaned = cleaned.replace(/\\t/g, "\t");
	cleaned = cleaned.replace(/\\r/g, "\r");
	if (STRING_CACHE.size > 2000) STRING_CACHE.clear();
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

export class MetadataParser {
	constructor(
		private settings: KoreaderHighlightImporterSettings,
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
			const luaContent =
				await this.sdrFinder.readMetadataFileContent(sdrDirectoryPath);
			if (!luaContent) {
				devWarn(
					`No metadata content found or readable in: ${sdrDirectoryPath}`,
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
			devError(`Error parsing metadata file in ${sdrDirectoryPath}:`, error);
			return null;
		}
	}

	private parseLuaContent(
		luaContent: string,
	): Omit<LuaMetadata, "originalFilePath" | "statistics"> {
		const result: Omit<LuaMetadata, "originalFilePath" | "statistics"> = {
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
				!ast.body ||
				ast.body.length === 0 ||
				ast.body[0].type !== "ReturnStatement"
			) {
				devWarn("Invalid Lua structure: Expected top-level return statement.");
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
				if (field.type !== "TableKey" || field.key.type !== "StringLiteral")
					continue;
				const key = field.key.raw.slice(1, -1);

				switch (key) {
					case "doc_props":
						result.docProps = this.extractDocProps(field.value);
						break;
					case "doc_pages":
						result.pages = this.extractNumericValue(field.value) ?? 0; // Ensure pages is number
						break;
					case "annotations":
						modernAnnotationsData = field;
						break;
					case "highlight":
						legacyHighlightData = field;
						break;
				}
			}

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
			return result;
		} catch (error) {
			if (error instanceof Error && "line" in error && "column" in error) {
				devError(
					`Lua parsing error at Line ${(error as any).line}, Column ${
						(error as any).column
					}: ${error.message}`,
					error.stack,
				);
			} else {
				devError("Error parsing Lua content:", error);
			}
			throw error; // Re-throw the error for parseFile to catch and return null
		}
	}

	// --- Extraction Helper Functions ---

	private extractDocProps(valueNode: Expression): DocProps {
		const docProps = { ...DEFAULT_DOC_PROPS };
		if (valueNode.type !== "TableConstructorExpression") {
			devWarn("doc_props was not a table, using defaults.");
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
					// devWarn(`Unknown doc_prop key encountered: ${propKey}`); // Optional: be less noisy
				}
			} // If extractedValue is null, the default from DEFAULT_DOC_PROPS remains
		}
		return docProps;
	}

	private extractAnnotations(
		field: TableKey,
		format: "modern" | "legacy",
	): Annotation[] {
		if (field.value.type !== "TableConstructorExpression") return [];
		const annotations: Annotation[] = [];

		if (format === "modern") {
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
					annotationFields = entry.value.fields;
				}
				if (annotationFields) {
					const annotation = this.createAnnotationFromFields(annotationFields);
					if (annotation) annotations.push(annotation);
				}
			}
		} else if (format === "legacy") {
			for (const pageField of field.value.fields) {
				if (
					pageField.type !== "TableKey" ||
					pageField.value.type !== "TableConstructorExpression"
				)
					continue;
				const pageNumStr = this.extractKeyAsString(pageField.key);
				const pageNum = pageNumStr ? Number.parseInt(pageNumStr, 10) : null;
				if (pageNum === null || Number.isNaN(pageNum)) {
					devWarn(
						`Invalid page number key in legacy 'highlight' table: ${pageNumStr}`,
					);
					continue;
				}
				for (const highlightGroupField of pageField.value.fields) {
					if (
						highlightGroupField.type !== "TableKey" ||
						highlightGroupField.value.type !== "TableConstructorExpression"
					)
						continue;
					const annotation = this.createAnnotationFromFields(
						highlightGroupField.value.fields,
					);
					if (annotation) {
						annotation.pageno = pageNum;
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
			if (!targetField) continue;

			const valueNode = field.value;
			switch (targetField) {
				case "page": {
					const pageNumVal = this.extractNumericValue(valueNode);
					if (pageNumVal !== null) annotation.page = pageNumVal;
					break;
				}
				case "drawer": {
					const drawerVal = this.extractStringValue(
						valueNode,
					)?.toLowerCase() as Annotation["drawer"];
					if (drawerVal && allowedDrawers.includes(drawerVal)) {
						annotation.drawer = drawerVal;
					} else if (drawerVal) {
						devWarn(`Invalid/unhandled drawer value: ${drawerVal}`);
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
			devWarn("Annotation missing datetime, using current time.");
		}
		if (!annotation.pos0 || !annotation.pos1) {
			devWarn(
				`Annotation for text "${annotation.text.slice(
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
