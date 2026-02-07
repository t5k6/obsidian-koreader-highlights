import luaparser from "luaparse";
import type {
	BooleanLiteral,
	Expression,
	NumericLiteral,
	StringLiteral,
	TableConstructorExpression,
	TableKey,
	TableKeyString,
	TableValue,
	UnaryExpression,
} from "luaparse/lib/ast";
import { err, ok, type Result } from "src/lib/core/result";
import type { ParseFailure } from "src/lib/errors/types";
import type { Annotation, DocProps, DrawerType, LuaMetadata } from "src/types";
import { DRAWER_TYPES } from "src/types";
import { z } from "zod";
import { normalizeFieldKey } from "../metadata/fieldMapping";

// ============================================================================
// 1. Generic Lua AST -> JS Value Converter
// ============================================================================

const sliceQuotes = (s: string): string =>
	s.length >= 2 &&
	((s.startsWith('"') && s.endsWith('"')) ||
		(s.startsWith("'") && s.endsWith("'")))
		? s.slice(1, -1)
		: s;

const sanitizeString = (raw: string): string => {
	// Handle Lua line continuations
	// In Lua, backslash at end of line means "continue string on next line"
	const withLineContinuationsAsNewlines = sliceQuotes(raw).replace(
		/\\(\r?\n)/g,
		"\n", // Replace line continuation with actual newline
	);

	// Then handle standard escape sequences
	return withLineContinuationsAsNewlines.replace(/\\(.)/g, (match, char) => {
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
};

/**
 * Recursively converts a Lua AST Expression into a native JavaScript value.
 *
 * Supported:
 * - primitives (string/number/boolean/nil)
 * - tables (object / array with safe heuristics)
 * - unary negative numeric literals
 */
function luaValueToJs(expr: Expression): unknown {
	switch (expr.type) {
		case "StringLiteral":
			return sanitizeString((expr as StringLiteral).raw);
		case "NumericLiteral":
			return (expr as NumericLiteral).value;
		case "BooleanLiteral":
			return (expr as BooleanLiteral).value;
		case "NilLiteral":
			return null;
		case "TableConstructorExpression":
			return evaluateTable(expr as TableConstructorExpression);
		case "UnaryExpression": {
			const u = expr as UnaryExpression;
			if (u.operator === "-" && u.argument.type === "NumericLiteral") {
				return -(u.argument as NumericLiteral).value;
			}
			return null;
		}
		default:
			return null;
	}
}

function evaluateTable(table: TableConstructorExpression): unknown {
	const resultObj: Record<string, unknown> = {};
	const resultArray: unknown[] = [];

	let hasStringKeys = false;
	let maxIntegerIndex = 0;
	let integerKeyCount = 0;
	let maxExplicitNumericKey = 0;

	// First pass: collect explicit numeric keys so we can avoid collisions
	for (const field of table.fields) {
		if (field.type !== "TableKey") continue;
		const kExpr = (field as TableKey).key;
		if (kExpr.type !== "NumericLiteral") continue;
		const n = kExpr.value;
		if (Number.isInteger(n) && n > 0 && n > maxExplicitNumericKey) {
			maxExplicitNumericKey = n;
		}
	}

	let implicitIndex = maxExplicitNumericKey > 0 ? maxExplicitNumericKey + 1 : 1;

	// Pass 2: extract all fields
	for (const field of table.fields) {
		let key: string | number | null = null;
		let valExpr: Expression;

		if (field.type === "TableValue") {
			key = implicitIndex++;
			valExpr = (field as TableValue).value;
		} else if (field.type === "TableKeyString") {
			key = (field as TableKeyString).key.name;
			valExpr = (field as TableKeyString).value;
			hasStringKeys = true;
		} else if (field.type === "TableKey") {
			const kExpr = (field as TableKey).key;
			valExpr = (field as TableKey).value;

			if (kExpr.type === "StringLiteral") {
				key = sanitizeString(kExpr.raw);
				hasStringKeys = true;
			} else if (kExpr.type === "NumericLiteral") {
				key = kExpr.value;
			} else {
				// Complex keys (variables etc) are not supported in JSON-like data
				continue;
			}
		} else {
			continue;
		}

		if (key === null) continue;
		const val = luaValueToJs(valExpr);
		resultObj[String(key)] = val;

		if (typeof key === "number") {
			if (Number.isInteger(key) && key > 0) {
				if (key > maxIntegerIndex) maxIntegerIndex = key;
				integerKeyCount++;

				// Only set array slots if key is "reasonable"; the final heuristic decides.
				resultArray[key - 1] = val;
			} else {
				// Floating point keys treat as object
				hasStringKeys = true;
			}
		}
	}

	// Array Heuristic:
	// 1) No string keys.
	// 2) Has integer keys.
	// 3) Dense enough (>= 50% density).
	// 4) Guard against huge allocations (page-keyed tables for large books).
	const isDense =
		maxIntegerIndex > 0 && integerKeyCount >= maxIntegerIndex * 0.5;
	const MAX_ARRAY_LENGTH = 10_000;

	if (!hasStringKeys && isDense && maxIntegerIndex <= MAX_ARRAY_LENGTH) {
		for (let i = 0; i < maxIntegerIndex; i++) {
			if (!(i in resultArray)) resultArray[i] = null;
		}
		if (resultArray.length > maxIntegerIndex) {
			resultArray.length = maxIntegerIndex;
		}
		return resultArray;
	}

	return resultObj;
}

// ============================================================================
// 2. Zod Schemas (Tolerant Validation)
// ============================================================================

const CoercedNumber = z.preprocess((val) => {
	if (typeof val === "number") return val;
	if (typeof val === "string" && val.trim().length > 0) {
		const n = Number(val);
		return Number.isNaN(n) ? undefined : n;
	}
	return undefined;
}, z.number().optional());

const CaseInsensitiveTransform = (obj: unknown) => {
	if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return obj;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(obj as Record<string, unknown>)) {
		out[k.toLowerCase()] = (obj as any)[k];
	}
	return out;
};

const DocPropsSchema = z.preprocess(
	CaseInsensitiveTransform,
	z
		.object({
			title: z.string().optional(),
			authors: z.string().optional(),
			description: z.string().optional(),
			keywords: z.string().optional(),
			series: z.string().optional(),
			language: z.string().optional(),
			identifiers: z.string().optional(),
		})
		.passthrough(),
);

const StatsSchema = z.preprocess(
	CaseInsensitiveTransform,
	z
		.object({
			pages: CoercedNumber,
			language: z.string().optional(),
		})
		.passthrough(),
);

const SummarySchema = z.preprocess(
	CaseInsensitiveTransform,
	z
		.object({
			status: z.string().optional(),
			modified: z.string().optional(),
			rating: CoercedNumber,
		})
		.passthrough(),
);

const MetadataRootSchema = z.preprocess(
	CaseInsensitiveTransform,
	z
		.object({
			doc_props: DocPropsSchema.optional(),
			doc_pages: CoercedNumber,
			partial_md5_checksum: z.string().optional(),
			percent_finished: CoercedNumber,
			summary: SummarySchema.optional(),
			stats: StatsSchema.optional(),
			annotations: z
				.union([z.array(z.any()), z.record(z.string(), z.any())])
				.optional(),
			highlight: z
				.union([z.array(z.any()), z.record(z.string(), z.any())])
				.optional(),
		})
		.passthrough(),
);

// ============================================================================
// 3. Domain Mapping (Normalization)
// ============================================================================

// Preserve existing default behavior.
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

function mapDocProps(
	raw: z.infer<typeof DocPropsSchema> | undefined,
): DocProps {
	const base: DocProps = { ...DEFAULT_DOC_PROPS };
	if (!raw) return base;

	if (raw.title) base.title = raw.title;
	if (raw.authors) base.authors = raw.authors;
	if (raw.description) base.description = raw.description;
	if (raw.series) base.series = raw.series;
	if (raw.language) base.language = raw.language;
	if (raw.identifiers) base.identifiers = raw.identifiers;

	if (raw.keywords) {
		base.keywords = raw.keywords
			.replace(/\\?\n/g, ", ")
			.replace(/,\s*,/g, ",")
			.trim();
	}

	return base;
}

const toDrawerType = (s: string): DrawerType | null => {
	const v = s.toLowerCase();
	return (DRAWER_TYPES as readonly string[]).includes(v)
		? (v as DrawerType)
		: null;
};

function mapAnnotation(raw: unknown, pageFallback: number): Annotation | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

	const normalized: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		normalized[normalizeFieldKey(k)] = v;
	}

	const text = typeof normalized.text === "string" ? normalized.text : "";
	if (!text.trim()) return null;

	let note = (normalized.note ?? normalized.notes ?? "") as unknown;
	if (Array.isArray(note)) note = note.join("\n");

	let drawer: DrawerType | undefined;
	if (typeof normalized.drawer === "string") {
		const d = toDrawerType(normalized.drawer);
		if (d) drawer = d;
	}

	const pageno =
		typeof normalized.pageno === "number" ? normalized.pageno : pageFallback;

	return {
		text,
		note: String(note),
		pageno,
		pageref:
			typeof normalized.pageref === "string" ? normalized.pageref : undefined,
		chapter:
			typeof normalized.chapter === "string" ? normalized.chapter : undefined,
		color:
			typeof normalized.color === "string"
				? normalized.color.trim()
				: undefined,
		drawer,
		datetime:
			typeof normalized.datetime === "string"
				? normalized.datetime
				: new Date().toISOString(),
		pos0: normalized.pos0 as any,
		pos1: normalized.pos1 as any,
	};
}

function normalizeAnnotations(rawList: unknown): Annotation[] {
	if (!rawList) return [];
	const out: Annotation[] = [];

	const traverse = (node: unknown, pageContext: number) => {
		if (!node || typeof node !== "object") return;

		// Arrays are containers of values
		if (Array.isArray(node)) {
			for (const item of node) traverse(item, pageContext);
			return;
		}

		// Try mapping as an annotation. If it maps, do not descend further.
		const candidate = mapAnnotation(node, pageContext);
		if (candidate) {
			out.push(candidate);
			return;
		}

		for (const [key, value] of Object.entries(
			node as Record<string, unknown>,
		)) {
			const numKey = Number(key);
			const nextPageContext =
				Number.isInteger(numKey) && numKey > 0 ? numKey : pageContext;
			traverse(value, nextPageContext);
		}
	};

	traverse(rawList, 0);
	return out;
}

// ============================================================================
// 4. Main Export
// ============================================================================

/**
 * Fast check to determine if Lua metadata contains any annotations.
 * Avoids full parsing when only checking for annotation presence.
 * This is 10-50x faster than full parsing for large files.
 *
 * @param luaCode - The Lua code to check
 * @returns true if annotations are likely present, false otherwise
 */
export function hasAnnotations(luaCode: string): boolean {
	// Quick regex check for annotations table with content
	// Matches both: annotations = { ... } and ["annotations"] = { ... }
	const annotationsPattern = /(?:\["annotations"\]|annotations)\s*=\s*\{/;
	const emptyAnnotationsPattern =
		/(?:\["annotations"\]|annotations)\s*=\s*\{\s*\}/;

	// Has annotations table but not empty
	return (
		annotationsPattern.test(luaCode) && !emptyAnnotationsPattern.test(luaCode)
	);
}

/**
 * Pure, stateless Lua parsing core.
 * Returns a Result containing the base metadata and diagnostics, or a structured ParseFailure.
 */
export function parse(luaContent: string): Result<ParseSuccess, ParseFailure> {
	let ast: any;
	try {
		ast = luaparser.parse(luaContent, {
			locations: true,
			comments: false,
		});
	} catch (e: any) {
		const loc =
			typeof e?.line === "number" && typeof e?.column === "number"
				? ` at line ${e.line}, column ${e.column}`
				: "";
		return err({
			kind: "LuaParseError",
			message: `${e?.message ?? String(e)}${loc}`,
			line: e?.line,
		});
	}

	const diagnostics: Diagnostic[] = [];

	const returns = (ast.body ?? []).filter(
		(n: any) => n && n.type === "ReturnStatement",
	);
	const lastReturn = returns.length > 0 ? returns[returns.length - 1] : null;
	if (!lastReturn) {
		return err({
			kind: "LuaParseError",
			message: "No return statement found in Lua script.",
		});
	}

	const retArg = (lastReturn as any).arguments?.[0];
	if (!retArg || retArg.type !== "TableConstructorExpression") {
		return err({
			kind: "LuaParseError",
			message: "Script did not return a configuration table.",
		});
	}

	const rawJs = luaValueToJs(retArg as Expression);
	const parsed = MetadataRootSchema.safeParse(rawJs);
	if (!parsed.success) {
		return err({
			kind: "LuaParseError",
			message: `Metadata structure invalid: ${parsed.error.message}`,
		});
	}

	const data = parsed.data;

	const meta: Omit<LuaMetadata, "originalFilePath" | "statistics"> = {
		docProps: mapDocProps(data.doc_props),
		pages: data.doc_pages ?? data.stats?.pages ?? 0,
		md5: data.partial_md5_checksum,
		percentFinished: data.percent_finished,
		luaSummary: data.summary,
		luaStats: data.stats,
		annotations: [],
	};

	const modernAnns = normalizeAnnotations(data.annotations);
	const legacyAnns = normalizeAnnotations(data.highlight);
	meta.annotations = [...modernAnns, ...legacyAnns].filter((a) =>
		a.text?.trim(),
	);

	diagnostics.push({
		severity: "info",
		message: `Parsed ${meta.annotations.length} valid annotation(s).`,
	});

	return ok({ meta, diagnostics });
}
