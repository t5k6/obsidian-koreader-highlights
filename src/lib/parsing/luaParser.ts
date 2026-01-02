import luaparser from "luaparse";
import type {
	Expression,
	TableKey,
	TableKeyString,
	TableValue,
} from "luaparse/lib/ast";
import { err, ok, type Result } from "src/lib/core/result";
import type { ParseFailure } from "src/lib/errors/types";
import type { Annotation, DocProps, DrawerType, LuaMetadata } from "src/types";
import { DRAWER_TYPES } from "src/types";
import { normalizeFieldKey } from "../metadata/fieldMapping";

// Pure utility functions
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

const toDrawerType = (s: string): DrawerType | null => {
	const v = s.toLowerCase();
	return (DRAWER_TYPES as readonly string[]).includes(v)
		? (v as DrawerType)
		: null;
};

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
	const base = { ...DEFAULT_DOC_PROPS };
	if (v.type !== "TableConstructorExpression") {
		return base;
	}
	for (const f of v.fields) {
		let k: string | null = null;
		if (f.type === "TableKeyString") {
			k = f.key.name;
		} else if (f.type === "TableKey") {
			k = extractKeyAsString(f.key);
		} else {
			continue;
		}
		if (!k) continue;
		const key = k.toLowerCase() as keyof DocProps;
		const val = extractStringValue(f.value);
		if (val == null) continue;
		switch (key) {
			case "title":
				base.title = val;
				break;
			case "authors":
				base.authors = val;
				break;
			case "description":
				base.description = val;
				break;
			case "keywords": {
				const normalized = val
					.replace(/\\?\n/g, ", ")
					.replace(/,\s*,/g, ",")
					.trim();
				base.keywords = normalized;
				break;
			}
			case "series":
				base.series = val;
				break;
			case "language":
				base.language = val;
				break;
			default:
				// Unknown key in doc_props: ignore to maintain strict typing
				break;
		}
	}
	return base;
};

const createAnnotationFromFields = (
	fields: Array<TableKey | TableKeyString | TableValue>,
): Annotation | null => {
	const ann: Partial<Annotation> = {};
	let pageNo: number | undefined;
	for (const f of fields) {
		let key: string | null = null;
		let valueExpr: Expression | null = null;
		if (f.type === "TableKey") {
			key = extractKeyAsString(f.key);
			valueExpr = f.value;
		} else if (f.type === "TableKeyString") {
			key = f.key.name;
			valueExpr = f.value;
		} else {
			continue;
		}
		if (!key) continue;
		const origLower = key.toLowerCase();
		const canonical = normalizeFieldKey(origLower);
		switch (canonical) {
			case "page":
			case "pageno": {
				const n = valueExpr ? extractNumericValue(valueExpr) : null;
				if (n != null) {
					pageNo = n;
				}
				break;
			}
			case "pageref": {
				const s = valueExpr ? extractStringValue(valueExpr) : null;
				if (s) ann.pageref = s;
				break;
			}

			case "drawer": {
				const s = valueExpr ? extractStringValue(valueExpr) : null;
				const d = s ? toDrawerType(s) : null;
				if (d) ann.drawer = d;
				break;
			}
			case "color": {
				const s = valueExpr ? extractStringValue(valueExpr) : null;
				if (s) ann.color = s.trim();
				break;
			}
			case "text": {
				const s = (valueExpr ? extractStringValue(valueExpr) : null) ?? "";
				ann.text = s;
				break;
			}
			case "note":
			case "notes": {
				const s = (valueExpr ? extractStringValue(valueExpr) : null) ?? "";
				ann.note = s;
				break;
			}
			case "chapter": {
				const s = valueExpr ? extractStringValue(valueExpr) : null;
				if (s) ann.chapter = s;
				break;
			}
			case "datetime": {
				const s =
					(valueExpr ? extractStringValue(valueExpr) : null) ?? undefined;
				if (s) ann.datetime = s;
				break;
			}
			case "pos0": {
				const s =
					(valueExpr ? extractStringValue(valueExpr) : null) ?? undefined;
				if (s) ann.pos0 = s;
				break;
			}
			case "pos1": {
				const s =
					(valueExpr ? extractStringValue(valueExpr) : null) ?? undefined;
				if (s) ann.pos1 = s;
				break;
			}
			default:
				break;
		}
	}
	// Ensure pageno has a safe default only if nothing was found
	if (pageNo === undefined) {
		pageNo = 0;
	}
	if (!ann.text || ann.text.trim() === "") return null;
	if (!ann.datetime) ann.datetime = new Date().toISOString();
	return { ...ann, pageno: pageNo } as Annotation;
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
				const nested = collectAnnotations(annotationNode, maxDepth, depth + 1);
				for (const a of nested.annotations) a.pageno = n;
				out.push(...nested.annotations);
				diags.push(...nested.diagnostics);
			}
		}
	}
	return { annotations: out, diagnostics: diags };
};

// Internal function to parse Lua content into AST
function parseLuaAst(luaContent: string): Result<any, ParseFailure> {
	try {
		const ast = luaparser.parse(luaContent, {
			locations: false,
			comments: false,
		});
		return ok(ast);
	} catch (e: any) {
		const loc =
			typeof e?.line === "number" && typeof e?.column === "number"
				? ` at line ${e.line}, column ${e.column}`
				: "";
		const message = `Lua parsing error${loc}: ${e?.message ?? String(e)}`;
		return err({
			kind: "LuaParseError",
			message: e?.message ?? String(e),
			line: e?.line,
		});
	}
}

// Internal function to extract metadata from AST
function extractMetadataFromAst(ast: any): Result<ParseSuccess, ParseFailure> {
	const diagnostics: Diagnostic[] = [];
	const DEFAULTS: DocProps = { ...DEFAULT_DOC_PROPS };
	const meta: Omit<LuaMetadata, "originalFilePath" | "statistics"> = {
		docProps: { ...DEFAULTS },
		pages: 0,
		annotations: [],
		md5: undefined,
	};

	const returns = (ast.body ?? []).filter(
		(n: any) => n && n.type === "ReturnStatement",
	);
	const lastReturn = returns.length > 0 ? returns[returns.length - 1] : null;
	if (!lastReturn) {
		diagnostics.push({
			severity: "warn",
			message: "Invalid Lua: expected top-level return statement.",
		});
		return ok({ meta, diagnostics });
	}
	const retArg = (lastReturn as any).arguments?.[0];
	if (!retArg || retArg.type !== "TableConstructorExpression") {
		diagnostics.push({
			severity: "warn",
			message: "Invalid Lua: expected returned table.",
		});
		return ok({ meta, diagnostics });
	}
	let modern: luaparser.TableConstructorExpression | null = null;
	let legacy: luaparser.TableConstructorExpression | null = null;
	for (const field of retArg.fields) {
		let key: string | null = null;
		if (field.type === "TableKeyString") {
			key = field.key.name.toLowerCase();
		} else if (field.type === "TableKey") {
			const k = extractKeyAsString(field.key);
			key = k ? k.toLowerCase() : null;
		} else {
			continue;
		}
		if (!key) continue;
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

	return ok({ meta, diagnostics });
}

const DEFAULT_DOC_PROPS: DocProps = {
	authors: "",
	title: "",
};

export type Diagnostic = {
	severity: "info" | "warn" | "error";
	message: string;
};

type ParseSuccess = {
	meta: Omit<LuaMetadata, "originalFilePath" | "statistics">;
	diagnostics: Diagnostic[];
};

/**
 * Pure, stateless Lua parsing core.
 * Returns a Result containing the base metadata and diagnostics, or a structured ParseFailure.
 */
export function parse(luaContent: string): Result<ParseSuccess, ParseFailure> {
	const astResult = parseLuaAst(luaContent);
	if (!astResult.ok) return err(astResult.error);
	return extractMetadataFromAst(astResult.value);
}
