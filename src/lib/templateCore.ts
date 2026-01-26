import { groupSuccessiveHighlights } from "src/lib/formatting/annotationGrouper";
import { formatDate } from "src/lib/formatting/dateUtils";
import { compareAnnotations } from "src/lib/formatting/formatUtils";
import { styleHighlight } from "src/lib/formatting/highlightStyle";
import {
	escapeHtml,
	escapeMarkdown,
	stripHtml,
	unescapeHtml,
} from "src/lib/strings/stringUtils";
import type {
	Annotation,
	CommentStyle,
	RenderContext,
	TemplateData,
} from "src/types";
import type { IterableCache } from "./cache";
import { createKohlMarkers } from "./kohlMarkers";

export type TemplateToken =
	| { type: "text"; value: string }
	| { type: "var"; key: string; filters?: string[] }
	| { type: "cond"; key: string; body: TemplateToken[] };

// Single source of truth for constants
export const MAX_TEMPLATE_NESTING = 20;

// Single registry of available filters
export const TEMPLATE_FILTERS = {
	stripHTML: {
		description: "Remove HTML tags and decode entities",
		apply: (s: string): string => stripHtml(s),
	},
	truncate: {
		description: "Truncate to N characters",
		requiresArg: true,
		apply: (s: string, arg?: string): string => {
			const n = Number.isFinite(Number(arg))
				? Number(arg)
				: parseInt(String(arg ?? ""), 10);
			return Number.isFinite(n) && n > 0 && s.length > n
				? s.slice(0, n) + "…"
				: s;
		},
	},
	br2nl: {
		description: "Convert <br> to newlines",
		apply: (s: string): string => s.replace(/<br\s*\/??\s*>/gi, "\n"),
	},
	quote: {
		description: "Prefix lines with > for Markdown quotes",
		apply: (s: string): string =>
			s
				.split(/\n/)
				.map((line) => (line.trim() === "" ? ">" : `> ${line}`))
				.join("\n"),
	},
	lower: {
		description: "Convert to lowercase",
		apply: (s: string): string => s.toLowerCase(),
	},
	upper: {
		description: "Convert to uppercase",
		apply: (s: string): string => s.toUpperCase(),
	},
	escape: {
		description: "Escape Markdown special characters",
		apply: escapeMarkdown,
	},
	escapeHtml: {
		description: "Escape HTML entities",
		apply: escapeHtml,
	},
	unescapeHtml: {
		description: "Unescape HTML entities",
		apply: unescapeHtml,
	},
	dateFormat: {
		description: "Format date string (e.g. YYYYMMDDHHmmss)",
		requiresArg: true,
		apply: (s: string, arg?: string): string => formatDate(s, arg),
	},
} as const;

export type FilterName = keyof typeof TEMPLATE_FILTERS;

function compileFilterPipeline(filters: string[]): (s: string) => string {
	const fns = filters.map((spec) => {
		const idx = spec.indexOf(":");
		const name = (idx >= 0 ? spec.slice(0, idx) : spec).trim() as FilterName;
		const arg = idx >= 0 ? spec.slice(idx + 1).trim() : undefined;
		const filter = TEMPLATE_FILTERS[name];
		return filter ? (s: string) => filter.apply(s, arg) : (s: string) => s;
	});
	return (s: string) => fns.reduce((acc, fn) => fn(acc), s);
}

export interface TemplateValidationResult {
	isValid: boolean;
	errors: string[];
	warnings: string[];
	suggestions: string[];
}

export function validateTemplate(template: string): TemplateValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const suggestions: string[] = [];
	const tokens = tokenize(template);

	const vars = extractVariables(tokens);
	const hasHighlight = vars.has("highlight") || vars.has("highlightPlain");
	if (!hasHighlight) {
		errors.push(
			"Missing required variable: {{highlight}} or {{highlightPlain}} ",
		);
		suggestions.push(
			"Add {{highlight}} for styled text or {{highlightPlain}} for plain text",
		);
	}
	if (!vars.has("pageno")) {
		errors.push("Missing required variable: {{pageno}}");
		suggestions.push("Add {{pageno}} to show page numbers");
	}

	const usedFilters = extractFilters(tokens);
	const knownFilters = new Set(Object.keys(TEMPLATE_FILTERS));
	for (const f of usedFilters) {
		if (!knownFilters.has(f)) {
			errors.push(`Unknown filter '{{ ${f} }}'`);
			// still surface as warning for less technical users
			warnings.push(`The filter '${f}' is not recognised and will be ignored.`);
		}
	}

	return {
		isValid: errors.length === 0,
		errors,
		warnings,
		suggestions,
	};
}

function normalizeKohlColor(raw?: string): string | undefined {
	if (!raw) return undefined;
	const n = raw.trim().toLowerCase();
	if (n === "grey") return "gray";
	const PALETTE = new Set([
		"red",
		"orange",
		"yellow",
		"green",
		"olive",
		"cyan",
		"blue",
		"purple",
		"gray",
	]);
	return PALETTE.has(n) ? n : undefined;
}

function mergeHighlightText(
	group: Annotation[],
	separators: (" " | " [...] ")[],
): string {
	const styled = group.map((ann) =>
		styleHighlight(ann.text ?? "", ann.color, ann.drawer),
	);
	return joinBlocks(styled, separators);
}

function mergeHighlightTextPlain(
	group: Annotation[],
	separators: (" " | " [...] ")[],
): string {
	const plainBlocks = group.map((ann) => {
		const raw = String(ann.text ?? "");
		const paragraphs = raw
			.split(/\r?\n\s*\r?\n/)
			.map((p) => escapeHtml(p.trim()))
			.filter(Boolean);
		return paragraphs.join("<br><br>");
	});
	return joinBlocks(plainBlocks, separators);
}

function mergeNotes(group: Annotation[]): string {
	const notes = group
		.map((g) => g.note)
		.filter((n): n is string => typeof n === "string" && n.trim() !== "");
	if (!notes.length) return "";
	return notes.join("\n---\n");
}

export function renderGroup(
	compiledFn: (data: TemplateData) => string,
	group: Annotation[],
	ctx: RenderContext,
): string {
	const head = group[0];
	const color = normalizeKohlColor(head.color);
	const data: TemplateData = {
		pageno: head.pageref ?? head.pageno ?? 0,
		pageref: head.pageref,
		date: formatDate(head.datetime),
		time: formatDate(head.datetime, "{YYYY}/{MM}/{DD} {HH}:{mm}:{ss}"),
		randomHex: Math.random().toString(16).slice(2, 6).padEnd(4, "0"),

		localeDate: formatDate(head.datetime, "locale"),
		dailyNoteLink: formatDate(head.datetime, "daily-note"),
		chapter: head.chapter?.trim() || "",
		isFirstInChapter: (ctx as any).isFirstInChapter ?? false,
		highlight: mergeHighlightText(
			group,
			ctx.separators ?? new Array(group.length - 1).fill(" "),
		),
		highlightPlain: mergeHighlightTextPlain(
			group,
			ctx.separators ?? new Array(group.length - 1).fill(" "),
		),
		note: mergeNotes(group),
		notes: group
			.map((g) => g.note)
			.filter((note): note is string => typeof note === "string"),
		color,
		drawer: head.drawer,
		khlBg: color ? `var(--khl-${color})` : undefined,
		khlFg: color ? `var(--on-khl-${color})` : undefined,
		callout: color ?? "note",
	};
	return compiledFn(data);
}

export function renderAnnotations(
	annotations: Annotation[],
	compiledTemplate: (data: TemplateData) => string,
	commentStyle: CommentStyle,
	maxHighlightGap: number,
): string {
	const anns = annotations ?? [];
	if (anns.length === 0) return "";

	const grouped = new Map<string, Annotation[]>();
	for (const ann of anns) {
		const chapter = ann.chapter?.trim() || "Chapter Unknown";
		const arr = grouped.get(chapter) ?? [];
		arr.push(ann);
		grouped.set(chapter, arr);
	}

	const chapters = Array.from(grouped.entries()).map(([name, list]) => {
		const sorted = [...list].sort(compareAnnotations);
		const startPage = sorted[0]?.pageno ?? 0;
		return {
			name,
			startPage,
			annotations: sorted.map((a) => ({ ...a, chapter: name })),
		};
	});

	chapters.sort((a, b) => a.startPage - b.startPage);

	const blocks: string[] = [];
	for (const chapter of chapters) {
		if (chapter.annotations.length === 0) continue;
		const groups = groupSuccessiveHighlights(
			chapter.annotations,
			maxHighlightGap,
		);
		let isFirst = true;
		for (const g of groups) {
			const rendered = renderGroup(compiledTemplate, g.annotations, {
				separators: g.separators,
				isFirstInChapter: isFirst,
			});
			const block =
				commentStyle !== "none"
					? `${createKohlMarkers(g.annotations, commentStyle)}\n${rendered}`
					: rendered;
			blocks.push(block);
			isFirst = false;
		}
	}

	return blocks.join("\n\n");
}

export function tokenize(
	template: string,
	maxDepth = MAX_TEMPLATE_NESTING,
): TemplateToken[] {
	const root: TemplateToken[] = [];
	type Frame = {
		key: string;
		tokens: TemplateToken[];
		parentTokens: TemplateToken[];
		parentLen: number;
		openStart: number;
		condKey?: string;
	};

	let current = root;
	const stack: Frame[] = [];
	let i = 0;

	const pushText = (s: string) => {
		if (s) current.push({ type: "text", value: s });
	};

	while (i < template.length) {
		const open = template.indexOf("{{", i);
		if (open === -1) {
			pushText(template.slice(i));
			break;
		}
		if (open > i) pushText(template.slice(i, open));

		const end = template.indexOf("}}", open + 2);
		if (end === -1) {
			pushText(template.slice(open));
			break;
		}

		const rawTag = template.slice(open + 2, end).trim();

		if (rawTag.startsWith("#")) {
			let key = rawTag.slice(1).trim();
			// Handle {{#if var}} syntax
			let expectedClose = key;
			if (key.startsWith("if ")) {
				expectedClose = "if";
				key = key.slice(3).trim();
			}

			if (!key || stack.length >= maxDepth) {
				// treat as text
				pushText(template.slice(open, end + 2));
				i = end + 2;
				continue;
			}
			// Open a new frame
			stack.push({
				key: expectedClose, // Store what we expect to close with (e.g. "if" or "note")
				tokens: [],
				parentTokens: current,
				parentLen: current.length,
				openStart: open,
				condKey: key, // Store the actual condition variable
			});
			current = stack[stack.length - 1].tokens;
			i = end + 2;
			continue;
		}

		if (rawTag.startsWith("/")) {
			const key = rawTag.slice(1).trim();
			const top = stack[stack.length - 1];
			if (top && top.key === key) {
				const frame = stack.pop()!;
				const cond: TemplateToken = { type: "cond", key: frame.condKey ?? frame.key, body: frame.tokens };
				current = frame.parentTokens;
				current.push(cond);
			} else {
				// stray closing tag: keep literal
				pushText(template.slice(open, end + 2));
			}
			i = end + 2;
			continue;
		}

		// var
		const parts = rawTag
			.split("|")
			.map((s) => s.trim())
			.filter(Boolean);
		const name = parts.shift() ?? "";
		if (/^\w+$/.test(name)) {
			current.push({
				type: "var",
				key: name,
				filters: parts.length ? parts : undefined,
			});
		} else {
			pushText(template.slice(open, end + 2));
		}
		i = end + 2;
	}

	// Unterminated frames: convert from the first open to end back into literal text
	if (stack.length) {
		const first = stack[0];
		first.parentTokens.splice(first.parentLen);
		first.parentTokens.push({
			type: "text",
			value: template.slice(first.openStart),
		});
	}

	return root;
}

export function applyFilters(
	value: unknown,
	filters?: string[],
	options?: { cache?: IterableCache<string, (s: string) => string> },
): string {
	const s = value == null ? "" : String(value);
	if (!filters || filters.length === 0) return s;

	const key = filters.join("|");
	const cache = options?.cache;
	let pipeline = cache?.get(key);

	if (!pipeline) {
		pipeline = compileFilterPipeline(filters);
		if (cache) {
			cache.set(key, pipeline);
		}
	}
	return pipeline(s);
}

export function detectNoteQuotingStyle(template: string): "auto" | "manual" {
	const noteLines = template
		.split(/\r?\n/)
		.filter((l) => l.includes("{{note}}"));
	const userHandlesQuoting = noteLines.some((l) => /^\s*>\s*/.test(l));
	return userHandlesQuoting ? "manual" : "auto";
}

export function renderNote(
	value: unknown,
	quotingStyle: "auto" | "manual",
): string {
	const s =
		typeof value === "string" ? value : value == null ? "" : String(value);
	if (!s) return "";
	const lines = s.split("\n");
	return quotingStyle === "manual"
		? lines.join("\n")
		: lines.map((l) => `> ${l}`).join("\n");
}

export function compile(
	templateString: string,
	options?: { cache?: IterableCache<string, (s: string) => string> },
): (data: TemplateData) => string {
	const tokens = tokenize(templateString);
	const quotingStyle = detectNoteQuotingStyle(templateString);
	const cache = options?.cache;

	const renderTokens = (ts: TemplateToken[], data: TemplateData): string => {
		let out = "";
		for (const t of ts) {
			if (t.type === "text") {
				out += t.value;
			} else if (t.type === "var") {
				const raw =
					t.key === "note"
						? renderNote((data as any).note, quotingStyle)
						: (data as any)[t.key];
				out += applyFilters(raw, t.filters, { cache });
			} else if (t.type === "cond") {
				if ((data as any)[t.key]) out += renderTokens(t.body, data);
			}
		}
		return out;
	};

	return (data: TemplateData) => renderTokens(tokens, data);
}

export function extractVariables(tokens: TemplateToken[]): Set<string> {
	const vars = new Set<string>();
	const visit = (ts: TemplateToken[]) => {
		for (const t of ts) {
			if (t.type === "var") vars.add(t.key);
			else if (t.type === "cond") {
				vars.add(t.key);
				visit(t.body);
			}
		}
	};
	visit(tokens);
	return vars;
}

export function extractFilters(tokens: TemplateToken[]): Set<string> {
	const filters = new Set<string>();
	const visit = (ts: TemplateToken[]) => {
		for (const t of ts) {
			if (t.type === "var" && t.filters) {
				for (const f of t.filters) {
					const parts = f.split(":");
					const [name] = parts.map((x) => x.trim());
					filters.add(name);
				}
			} else if (t.type === "cond") {
				visit(t.body);
			}
		}
	};
	visit(tokens);
	return filters;
}

export function joinBlocks(
	blocks: string[],
	separators: (" " | " [...] ")[],
): string {
	if (blocks.length === 0) return "";
	let out = blocks[0];
	for (let i = 1; i < blocks.length; i++) {
		const sep = separators[i - 1];
		if (sep === " ") out += ` ${blocks[i]}`;
		else {
			if (!out.endsWith("<br><br>")) out += "<br><br>";
			out += `[...]<br><br>${blocks[i]}`;
		}
	}
	return out;
}
