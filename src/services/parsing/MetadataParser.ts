import luaparser from "luaparse";
import type {
	Expression,
	TableKey,
	TableKeyString,
	TableValue,
} from "luaparse/lib/ast";
import type { Annotation, DocProps, LuaMetadata } from "src/types";

const DEFAULT_DOC_PROPS: DocProps = {
	authors: "",
	title: "",
	description: "",
	keywords: "",
	series: "",
	language: "en",
};

export type Diagnostic = {
	severity: "info" | "warn" | "error";
	message: string;
};

/**
 * Pure, stateless Lua parsing core.
 * Returns the base metadata (no originalFilePath/statistics).
 */
export function parse(luaContent: string): {
	meta: Omit<LuaMetadata, "originalFilePath" | "statistics">;
	diagnostics: Diagnostic[];
} {
	const diagnostics: Diagnostic[] = [];
	const DEFAULTS: DocProps = { ...DEFAULT_DOC_PROPS };
	const meta: Omit<LuaMetadata, "originalFilePath" | "statistics"> = {
		docProps: { ...DEFAULTS },
		pages: 0,
		annotations: [],
		md5: undefined,
	};

	const sliceQuotes = (s: string): string =>
		s.length >= 2 &&
		((s.startsWith('"') && s.endsWith('"')) ||
			(s.startsWith("'") && s.endsWith("'")))
			? s.slice(1, -1)
			: s;

	const sanitizeString = (raw: string): string =>
		sliceQuotes(raw).replace(/\\(.)/g, (match, char) => {
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

	const extractKeyAsString = (k: Expression): string | null => {
		switch (k.type) {
			case "StringLiteral":
				return sliceQuotes(k.raw);
			case "NumericLiteral":
				return String(k.value);
			case "Identifier":
				return k.name;
			default:
				return null;
		}
	};

	const extractStringValue = (v: Expression): string | null => {
		switch (v.type) {
			case "StringLiteral":
				return sanitizeString(v.raw);
			case "NumericLiteral":
				return String(v.value);
			case "BooleanLiteral":
				return String(v.value);
			default:
				return null;
		}
	};

	const extractNumericValue = (v: Expression): number | null => {
		switch (v.type) {
			case "NumericLiteral":
				return v.value;
			case "StringLiteral": {
				const n = Number.parseFloat(sanitizeString(v.raw));
				return Number.isNaN(n) ? null : n;
			}
			default:
				return null;
		}
	};

	const extractDocProps = (v: Expression): DocProps => {
		const base = { ...DEFAULTS };
		if (v.type !== "TableConstructorExpression") {
			diagnostics.push({
				severity: "warn",
				message: "doc_props is not a table; using defaults.",
			});
			return base;
		}
		for (const f of v.fields) {
			if (f.type !== "TableKey" || f.key.type !== "StringLiteral") continue;
			const k = sliceQuotes(f.key.raw) as keyof DocProps;
			let val = extractStringValue(f.value);
			if (val != null) {
				if (k === "keywords") {
					val = val.replace(/\\?\n/g, ", ").replace(/,\s*,/g, ",").trim();
				}
				if (k in base) (base as any)[k] = val;
			}
		}
		return base;
	};

	const createAnnotationFromFields = (
		fields: Array<TableKey | TableKeyString | TableValue>,
	): Annotation | null => {
		const ann: Partial<Annotation> & { page?: number } = {};
		for (const f of fields) {
			if (f.type !== "TableKey") continue;
			const key = extractKeyAsString(f.key);
			if (!key) continue;
			switch (key.toLowerCase()) {
				case "pageno": {
					// Prioritize 'pageno'
					const n = extractNumericValue(f.value);
					if (n != null) (ann as any).pageno = n;
					break;
				}
				case "page": {
					// Fallback if pageno isn't set yet
					if ((ann as any).pageno === undefined) {
						const n = extractNumericValue(f.value);
						if (n != null) (ann as any).pageno = n;
					}
					break;
				}
				case "drawer": {
					const s = extractStringValue(f.value);
					if (s) (ann as any).drawer = s.toLowerCase();
					break;
				}
				case "text":
				case "note": {
					const s = extractStringValue(f.value) ?? "";
					(ann as any)[key.toLowerCase()] = s;
					break;
				}
				case "chapter": {
					// Add support for chapter
					const s = extractStringValue(f.value);
					if (s) (ann as any).chapter = s;
					break;
				}
				case "datetime":
				case "pos0":
				case "pos1": {
					const s = extractStringValue(f.value) ?? undefined;
					(ann as any)[key.toLowerCase()] = s as any;
					break;
				}
				default:
					break;
			}
		}
		// Ensure pageno has a safe default only if nothing was found
		if ((ann as any).pageno === undefined) {
			(ann as any).pageno = 0;
		}
		if (!ann.text || ann.text.trim() === "") return null;
		if (!ann.datetime) ann.datetime = new Date().toISOString();
		return ann as Annotation;
	};

	const collectAnnotations = (
		node: luaparser.TableConstructorExpression,
		maxDepth: number,
		depth = 0,
	): { annotations: Annotation[]; diagnostics: Diagnostic[] } => {
		const diags: Diagnostic[] = [];
		if (depth > maxDepth) {
			diags.push({
				severity: "warn",
				message: "Annotation nesting too deep; stopping recursion.",
			});
			return { annotations: [], diagnostics: diags };
		}
		const out: Annotation[] = [];
		for (const field of node.fields) {
			let annotationNode: luaparser.TableConstructorExpression | null = null;
			if (
				(field.type === "TableValue" || field.type === "TableKey") &&
				field.value.type === "TableConstructorExpression"
			) {
				annotationNode = field.value;
			}
			if (!annotationNode) continue;
			const ann = createAnnotationFromFields(annotationNode.fields);
			if (ann?.text?.trim()) {
				out.push(ann);
				continue;
			}
			if (field.type === "TableKey" && field.key) {
				const k = extractKeyAsString(field.key);
				const n = k ? Number(k) : NaN;
				if (Number.isFinite(n)) {
					const nested = collectAnnotations(
						annotationNode,
						maxDepth,
						depth + 1,
					);
					for (const a of nested.annotations) (a as any).pageno = n;
					out.push(...nested.annotations);
					diags.push(...nested.diagnostics);
				}
			}
		}
		return { annotations: out, diagnostics: diags };
	};

	try {
		const ast = luaparser.parse(luaContent, {
			locations: false,
			comments: false,
		});
		const first = ast.body?.[0];
		if (!first || first.type !== "ReturnStatement") {
			diagnostics.push({
				severity: "warn",
				message: "Invalid Lua: expected top-level return statement.",
			});
			return { meta, diagnostics };
		}
		const retArg = first.arguments?.[0];
		if (!retArg || retArg.type !== "TableConstructorExpression") {
			diagnostics.push({
				severity: "warn",
				message: "Invalid Lua: expected returned table.",
			});
			return { meta, diagnostics };
		}
		let modern: luaparser.TableConstructorExpression | null = null;
		let legacy: luaparser.TableConstructorExpression | null = null;
		for (const field of retArg.fields) {
			if (field.type !== "TableKey" || field.key.type !== "StringLiteral")
				continue;
			const key = field.key.raw.slice(1, -1).toLowerCase();
			switch (key) {
				case "doc_props":
					meta.docProps = extractDocProps(field.value);
					break;
				case "doc_pages":
					meta.pages = extractNumericValue(field.value) ?? 0;
					break;
				case "partial_md5_checksum":
					meta.md5 = extractStringValue(field.value) ?? undefined;
					break;
				case "annotations":
					if (field.value.type === "TableConstructorExpression")
						modern = field.value;
					break;
				case "highlight":
					if (field.value.type === "TableConstructorExpression")
						legacy = field.value;
					break;
			}
		}
		let annotations: Annotation[] = [];
		if (modern) {
			const out = collectAnnotations(modern, 10);
			annotations = out.annotations;
			diagnostics.push(...out.diagnostics);
		}
		if (annotations.length === 0 && legacy) {
			const out = collectAnnotations(legacy, 10);
			annotations = out.annotations;
			diagnostics.push(...out.diagnostics);
		}
		meta.annotations = annotations.filter((a) => a.text?.trim());
		diagnostics.push({
			severity: "info",
			message: `Parsed ${meta.annotations.length} valid annotation(s).`,
		});
	} catch (e: any) {
		const loc =
			typeof e?.line === "number" && typeof e?.column === "number"
				? ` at line ${e.line}, column ${e.column}`
				: "";
		diagnostics.push({
			severity: "error",
			message: `Lua parsing error${loc}: ${e?.message ?? String(e)}`,
		});
	}
	return { meta, diagnostics };
}
