import { normalizePath, Notice, TFile, type Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { TemplateData } from "src/types";
import { styleHighlight } from "src/utils/highlightStyle";
import type {
	Annotation,
	KoreaderHighlightImporterSettings,
	RenderContext,
	TemplateDefinition,
} from "../types";
import { ensureFolderExists } from "../utils/fileUtils";
import { formatDate } from "../utils/formatUtils";
import { devError, devLog, devWarn } from "../utils/logging";

export const FALLBACK_TEMPLATE_ID = "default";
const DARK_THEME_CLASS = "theme-dark";

export interface TemplateValidationResult {
	isValid: boolean;
	errors: string[];
	warnings: string[];
	suggestions: string[];
}

export class TemplateManager {
	private isDarkTheme: boolean;
	private templateCache: Map<string, string> = new Map();
	public builtInTemplates: Map<string, TemplateDefinition> = new Map();
	private currentTemplateFlags = {
		autoInsertDivider: true,
		autoPrefixNotes: true,
	};

	constructor(
		public plugin: KoreaderImporterPlugin,
		private vault: Vault,
		private settings: KoreaderHighlightImporterSettings,
		isDarkTheme?: boolean,
	) {
		this.isDarkTheme =
			isDarkTheme ?? document.body.classList.contains(DARK_THEME_CLASS);
		devLog(`TemplateManager initialized. Dark theme: ${this.isDarkTheme}`);
	}

	private analyseTemplateFeatures(tpl: string): {
		autoPrefixNotes: boolean;
		autoInsertDivider: boolean;
	} {
		// ---------- 1. note prefix test ----------
		// Look at every *line* that contains {{note}}.
		// If ANY such line starts with '>' (ignoring leading whitespace)
		// we assume the user is handling the block-quote themselves.
		const noteLines = tpl.split(/\r?\n/).filter((l) => l.includes("{{note}}"));
		const userHandlesPrefix = noteLines.some((l) => /^\s*>\s*/.test(l));
		const autoPrefixNotes = !userHandlesPrefix; // invert

		// ---------- 2. divider test ----------
		// If we spot a horizontal rule or <hr> anywhere, we won’t add another.
		const hasMdRule = /^\s*(-{3,}|_{3,}|\*{3,})\s*$/m.test(tpl);
		const hasHtmlHr = /<hr\s*\/?>/i.test(tpl);
		const autoInsertDivider = !(hasMdRule || hasHtmlHr);

		return { autoPrefixNotes, autoInsertDivider };
	}

	public shouldAutoInsertDivider(): boolean {
		return this.currentTemplateFlags.autoInsertDivider;
	}

	public async loadBuiltInTemplates(): Promise<void> {
		if (this.builtInTemplates.size > 0) return;

		try {
			const rawTemplates: Record<string, string> = JSON.parse(
				KOREADER_BUILTIN_TEMPLATES,
			);

			for (const id in rawTemplates) {
				const content = rawTemplates[id];
				const name = id
					.replace(/-/g, " ")
					.replace(/\b\w/g, (l) => l.toUpperCase());

				const fmMatch = content.match(/^---\s*description:\s*(.*?)\s*---/s);
				const description = fmMatch
					? fmMatch[1].trim()
					: `The ${name} template.`;

				const templateContent = content.replace(/^---.*?---\s*/s, "");

				this.builtInTemplates.set(id, {
					id,
					name,
					description,
					content: templateContent,
				});
			}
		} catch (error) {
			devError("Failed to parse or load embedded built-in templates.", error);
		}

		devLog(
			`Loaded ${this.builtInTemplates.size} built-in templates from bundle.`,
		);
	}

	updateSettings(newSettings: KoreaderHighlightImporterSettings): void {
		const templateChanged =
			this.settings.template.selectedTemplate !==
				newSettings.template.selectedTemplate ||
			this.settings.template.useCustomTemplate !==
				newSettings.template.useCustomTemplate;

		this.settings = newSettings;

		if (templateChanged) {
			this.clearCache();
			devLog("Template settings changed, cache cleared.");
		}
	}

	public validateTemplate(content: string): TemplateValidationResult {
		const result: TemplateValidationResult = {
			isValid: true,
			errors: [],
			warnings: [],
			suggestions: [],
		};

		const requiredVars = ["highlight", "pageno"];
		const foundVars = new Set(
			[...content.matchAll(/{{([\w]+)}}/g)].map((m) => m[1]),
		);

		requiredVars.forEach((v) => {
			if (!foundVars.has(v)) {
				result.errors.push(`Missing required variable: {{${v}}}`);
				result.isValid = false;
			}
		});

		if (content.includes("{{#note}}") && !content.includes("{{/note}}")) {
			result.errors.push("Unclosed {{#note}} block found.");
			result.isValid = false;
		}

		if (
			!content.includes("{{chapter}}") &&
			!content.includes("{{#isFirstInChapter}}")
		) {
			result.suggestions.push(
				"Consider adding {{chapter}} or {{#isFirstInChapter}} for better organization.",
			);
		}

		if (/<[a-z][\s\S]*>/i.test(content)) {
			result.warnings.push(
				"HTML detected. This is powerful but may require custom CSS for correct styling.",
			);
		}

		return result;
	}

	async loadTemplate(): Promise<string> {
		const { useCustomTemplate, selectedTemplate } = this.settings.template;
		const templateId = selectedTemplate || FALLBACK_TEMPLATE_ID;

		const cached = this.templateCache.get(templateId);
		if (cached) {
			this.currentTemplateFlags = this.analyseTemplateFeatures(cached);
			return cached;
		}

		let templateContent: string;

		if (!useCustomTemplate) {
			const builtIn = this.builtInTemplates.get(templateId);
			templateContent =
				builtIn?.content ??
				this.builtInTemplates.get(FALLBACK_TEMPLATE_ID)?.content ??
				"";
		} else {
			let loadedFromVault = await this.loadTemplateFromVault(templateId);
			if (!loadedFromVault) {
				new Notice(
					`Custom template "${templateId}" not found. Falling back to Default.`,
				);
				loadedFromVault =
					this.builtInTemplates.get(FALLBACK_TEMPLATE_ID)?.content ?? "";
			}
			templateContent = loadedFromVault.replace(/^---.*?---\s*/s, "");
		}

		const validation = this.validateTemplate(templateContent);
		if (!validation.isValid) {
			new Notice(
				`Custom template "${templateId}" has errors. Falling back to Default. Check console for details.`,
			);
			devError("Custom template validation failed:", validation.errors);
			templateContent =
				this.builtInTemplates.get(FALLBACK_TEMPLATE_ID)?.content ?? "";
		}

		this.currentTemplateFlags = this.analyseTemplateFeatures(templateContent);
		this.templateCache.set(templateId, templateContent);
		return templateContent;
	}

	public async loadTemplateFromVault(
		vaultPath: string,
	): Promise<string | null> {
		const normalizedPath = normalizePath(vaultPath);
		const file = this.vault.getAbstractFileByPath(normalizedPath);

		if (file instanceof TFile) {
			return this.vault.read(file);
		}

		devWarn(`Custom template file not found in vault: "${vaultPath}"`);
		return null;
	}

	public render(templateString: string, data: TemplateData): string {
		const withConditionals = this.processConditionalBlocks(
			templateString,
			data,
		);
		const withVariables = this.processSimpleVariables(withConditionals, data);
		return withVariables.trim();
	}

	private async loadFromVault(templateId: string): Promise<string | null> {
		const vaultPath = normalizePath(templateId);
		const file = this.vault.getAbstractFileByPath(vaultPath);

		if (file instanceof TFile) {
			return this.vault.read(file);
		}

		devWarn(`Template not found in vault: "${vaultPath}"`);
		return null;
	}

	private processConditionalBlocks(
		template: string,
		data: TemplateData,
	): string {
		const innermostRegex = /{{#(\w+)}}(.*?){{\/\1}}/gs;
		let processedTemplate = template;
		let lastTemplate: string;

		do {
			lastTemplate = processedTemplate;
			processedTemplate = processedTemplate.replace(
				innermostRegex,
				(_, key, content) => {
					const value = data[key];
					let shouldRender: boolean;
					if (typeof value === "boolean") {
						shouldRender = value;
					} else if (typeof value === "string") {
						shouldRender = value.trim() !== "";
					} else {
						shouldRender = value !== null && value !== undefined;
					}
					if (key === "isFirstInChapter" && !data.chapter?.trim()) {
						shouldRender = false;
					}
					return shouldRender ? content : "";
				},
			);
		} while (processedTemplate !== lastTemplate);

		return processedTemplate;
	}

	private processSimpleVariables(template: string, data: TemplateData): string {
		const noteLineHasQuote = /^[ \t]*>[^\n]*\{\{note\}\}/m.test(template);

		return template.replace(/\{\{((?!#|\/)[\w]+)\}\}/g, (_, key) => {
			if (key === "note" && typeof data.note === "string") {
				const lines = data.note.split("\n");

				// CASE 1 – template already provides the first “> ”  →  prefix only the *next* lines
				if (noteLineHasQuote) {
					return lines
						.map((line, idx) => (idx === 0 ? line : `> ${line}`))
						.join("\n");
				}

				// CASE 2 – template has NO block-quote and our auto-detect decided
				//          to add one for every line
				if (this.currentTemplateFlags.autoPrefixNotes) {
					return lines.map((line) => `> ${line}`).join("\n");
				}

				// CASE 3 – template wants the raw, unprefixed text
				return data.note;
			}

			// … untouched replacement for non-note variables
			return data[key]?.toString() ?? "";
		});
	}

	async ensureTemplates(): Promise<void> {
		const defaultPluginTemplateDir = normalizePath(
			this.settings.template.templateDir || "KOReader/templates",
		);

		try {
			await ensureFolderExists(this.vault, defaultPluginTemplateDir);
		} catch (err) {
			return;
		}

		if (this.builtInTemplates.size === 0) {
			await this.loadBuiltInTemplates();
		}

		for (const template of this.builtInTemplates.values()) {
			const filePath = normalizePath(
				`${defaultPluginTemplateDir}/${template.id}.md`,
			);
			if (!(await this.vault.adapter.exists(filePath))) {
				devLog(`Creating built-in template file: ${filePath}`);
				const fileContent = `---
description: ${template.description}
---
${template.content}`;
				await this.vault.create(filePath, fileContent);
			}
		}
	}

	clearCache(): void {
		this.templateCache.clear();
		devLog("TemplateManager cache cleared.");
	}

	public renderGroup(
		templateStr: string,
		group: Annotation[],
		ctx: RenderContext,
	): string {
		const head = group[0];

		const data: TemplateData = {
			pageno: head.pageno ?? 0,
			date: formatDate(head.datetime),
			chapter: head.chapter?.trim() || "",
			isFirstInChapter: (ctx as any).isFirstInChapter ?? false,
			highlight: this.mergeHighlightText(
				group,
				ctx.separators ?? new Array(group.length - 1).fill(" "),
			),
			note: this.mergeNotes(group),
			notes: group
				.map((g) => g.note)
				.filter((note): note is string => typeof note === "string"),
		};

		return this.render(templateStr, data);
	}

	private mergeHighlightText(
		group: Annotation[],
		separators: (" " | " [...] ")[],
	): string {
		if (group.length === 1) {
			const h = group[0];
			return styleHighlight(h.text ?? "", h.color, h.drawer, this.isDarkTheme);
		}

		return group
			.map((h, idx) => {
				const styled = styleHighlight(
					h.text ?? "",
					h.color,
					h.drawer,
					this.isDarkTheme,
				);
				if (idx === 0) return styled;
				const sep = separators[idx - 1] ?? " ";
				return sep + styled;
			})
			.join("");
	}

	private mergeNotes(group: Annotation[]): string {
		const notes = group
			.map((g) => g.note)
			.filter((n): n is string => typeof n === "string");
		if (!notes.length) return "";
		return notes.join("\n\n---\n\n");
	}
}
