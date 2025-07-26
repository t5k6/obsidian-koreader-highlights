import { normalizePath, Notice, TFile, type Vault } from "obsidian";
import { DEFAULT_TEMPLATES_FOLDER } from "src/constants";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { CacheManager } from "src/utils/cache/CacheManager";
import { LruCache } from "src/utils/cache/LruCache";
import { ensureFolderExists } from "src/utils/fileUtils";
import {
	formatDate,
	formatDateAsDailyNote,
	formatDateLocale,
} from "src/utils/formatUtils";
import { styleHighlight } from "src/utils/highlightStyle";
import { createLogger, logger } from "src/utils/logging";
import type {
	Annotation,
	KoreaderHighlightImporterSettings,
	RenderContext,
	TemplateData,
	TemplateDefinition,
} from "../types";

export const FALLBACK_TEMPLATE_ID = "default";
const DARK_THEME_CLASS = "theme-dark";

const MD_RULE_REGEX = /^\s*(-{3,}|_{3,}|\*{3,})\s*$/m;
const HTML_HR_REGEX = /<hr\s*\/?>/i;
const NOTE_LINE_REGEX = /^\s*>\s*/;
const CONDITIONAL_BLOCK_REGEX = /{{#(\w+)}}(.*?)({{\/\1}})/gs;
const SIMPLE_VAR_REGEX = /\{\{((?!#|\/)[\w]+)\}\}/g;
const TEMPLATE_FRONTMATTER_REGEX = /^---.*?---\s*/s;

export type CompiledTemplate = (data: TemplateData) => string;

interface CachedTemplate {
	fn: CompiledTemplate;
	features: {
		autoInsertDivider: boolean;
	};
}

export interface TemplateValidationResult {
	isValid: boolean;
	errors: string[];
	warnings: string[];
	suggestions: string[];
}

const log = createLogger("TemplateManager");

export class TemplateManager {
	private isDarkTheme: boolean = true;
	private rawTemplateCache = new LruCache<string, string>(10);
	private compiledTemplateCache = new LruCache<string, CachedTemplate>(10);
	public builtInTemplates: Map<string, TemplateDefinition> = new Map();

	constructor(
		public plugin: KoreaderImporterPlugin,
		private vault: Vault,
		private cacheManager: CacheManager,
	) {
		this.rawTemplateCache = cacheManager.createLru("template.raw", 10);
		this.compiledTemplateCache = cacheManager.createLru(
			"template.compiled",
			10,
		);

		this.updateTheme = this.updateTheme.bind(this);
		this.updateTheme();
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("css-change", this.updateTheme),
		);
		logger.info(`TemplateManager initialized. Dark theme: ${this.isDarkTheme}`);
	}

	private updateTheme(): void {
		const newThemeState = document.body.classList.contains(DARK_THEME_CLASS);
		if (this.isDarkTheme !== newThemeState) {
			this.isDarkTheme = newThemeState;
			logger.info(
				`TemplateManager: Theme changed. Dark theme: ${this.isDarkTheme}`,
			);
		}
	}

	private analyseTemplateFeatures(tpl: string): CachedTemplate["features"] {
		const noteLines = tpl.split(/\r?\n/).filter((l) => l.includes("{{note}}"));
		const userHandlesPrefix = noteLines.some((l) => NOTE_LINE_REGEX.test(l));

		const hasMdRule = MD_RULE_REGEX.test(tpl);
		const hasHtmlHr = HTML_HR_REGEX.test(tpl);
		const autoInsertDivider = !(hasMdRule || hasHtmlHr);

		return { autoInsertDivider };
	}

	private compile(templateString: string): CompiledTemplate {
		const noteLineHasQuote = /^[ \t]*>[^\n]*\{\{note\}\}/m.test(templateString);
		const noteLines = templateString
			.split(/\r?\n/)
			.filter((l) => l.includes("{{note}}"));
		const userHandlesPrefix = noteLines.some((l) => NOTE_LINE_REGEX.test(l));
		const autoPrefixNotes = !userHandlesPrefix;

		let noteReplacementLogic: string;
		if (noteLineHasQuote) {
			noteReplacementLogic = `(d.note || '').split('\\n').map((l, i) => i === 0 ? l : '> ' + l).join('\\n')`;
		} else if (autoPrefixNotes) {
			noteReplacementLogic = `(d.note || '').split('\\n').map(l => '> ' + l).join('\\n')`;
		} else {
			noteReplacementLogic = `d.note ?? ''`;
		}

		const code = templateString
			.replace(/\\/g, "\\\\")
			.replace(/`/g, "\\`")
			.replace(
				CONDITIONAL_BLOCK_REGEX,
				(_, key, body) => `\${(d.${key}) ? \`${body}\` : ''}`,
			)
			.replace(SIMPLE_VAR_REGEX, (_, key) => {
				if (key === "note") return `\${${noteReplacementLogic}}`;
				return `\${d.${key} ?? ''}`;
			});

		const functionBody = `return \`${code}\`;`;

		try {
			// eslint-disable-next-line no-new-func
			return new Function("d", functionBody) as CompiledTemplate;
		} catch (error) {
			logger.error("TemplateManager: Failed to compile template.", error, {
				template: functionBody,
			});
			return () => "Error: Template compilation failed.";
		}
	}

	public async shouldAutoInsertDivider(): Promise<boolean> {
		const { features } = await this.getCompiledTemplate();
		return features.autoInsertDivider;
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
				const templateContent = content.replace(TEMPLATE_FRONTMATTER_REGEX, "");
				this.builtInTemplates.set(id, {
					id,
					name,
					description,
					content: templateContent,
				});
			}
		} catch (error) {
			logger.error(
				"TemplateManager: Failed to parse built-in templates.",
				error,
			);
		}
		logger.info(
			`TemplateManager: Loaded ${this.builtInTemplates.size} built-in templates.`,
		);
	}

	updateSettings(newSettings: KoreaderHighlightImporterSettings): void {
		const settings = this.plugin.settings;
		const templateChanged =
			settings.template.useCustomTemplate !==
				newSettings.template.useCustomTemplate ||
			settings.template.selectedTemplate !==
				newSettings.template.selectedTemplate ||
			settings.template.templateDir !== newSettings.template.templateDir;

		this.plugin.settings = newSettings;

		if (templateChanged) {
			this.cacheManager.clear("template.*");
			logger.info(
				"TemplateManager: Template settings changed, relevant caches cleared.",
			);
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
			[...content.matchAll(SIMPLE_VAR_REGEX)].map((m) => m[1]),
		);

		requiredVars.forEach((v) => {
			if (!foundVars.has(v)) {
				result.errors.push(`Missing required variable: {{${v}}}`);
				result.isValid = false;
			}
		});

		if (/<[a-z][\s\S]*>/i.test(content)) {
			result.warnings.push("HTML detected; may require custom CSS.");
		}
		return result;
	}

	async loadTemplate(): Promise<string> {
		const { useCustomTemplate, selectedTemplate } =
			this.plugin.settings.template;
		const templateId = selectedTemplate || FALLBACK_TEMPLATE_ID;

		const cacheKey = useCustomTemplate ? templateId : `builtin_${templateId}`;
		const cached = this.rawTemplateCache.get(cacheKey);
		if (cached) return cached;

		let templateContent: string;
		if (!useCustomTemplate) {
			const builtIn = this.builtInTemplates.get(templateId);
			templateContent =
				builtIn?.content ??
				this.builtInTemplates.get(FALLBACK_TEMPLATE_ID)?.content ??
				"";
		} else {
			const loadedFromVault = await this.loadTemplateFromVault(templateId);
			if (!loadedFromVault) {
				new Notice(
					`Custom template "${templateId}" not found. Falling back to Default.`,
				);
				templateContent =
					this.builtInTemplates.get(FALLBACK_TEMPLATE_ID)?.content ?? "";
			} else {
				templateContent = loadedFromVault.replace(
					TEMPLATE_FRONTMATTER_REGEX,
					"",
				);
			}
		}

		const validation = this.validateTemplate(templateContent);
		if (!validation.isValid) {
			new Notice(
				`Template "${templateId}" has errors. Falling back to Default.`,
			);
			logger.error(
				"TemplateManager: Template validation failed:",
				validation.errors,
			);
			templateContent =
				this.builtInTemplates.get(FALLBACK_TEMPLATE_ID)?.content ?? "";
		}

		this.rawTemplateCache.set(cacheKey, templateContent);
		return templateContent;
	}

	public async getCompiledTemplate(): Promise<CachedTemplate> {
		const { useCustomTemplate, selectedTemplate } =
			this.plugin.settings.template;
		const templateId = selectedTemplate || FALLBACK_TEMPLATE_ID;
		const cacheKey = useCustomTemplate ? templateId : `builtin_${templateId}`;

		let cached = this.compiledTemplateCache.get(cacheKey);
		if (cached) return cached;

		const rawTemplate = await this.loadTemplate();
		const compiledFn = this.compile(rawTemplate);
		const features = this.analyseTemplateFeatures(rawTemplate);

		cached = { fn: compiledFn, features };
		this.compiledTemplateCache.set(cacheKey, cached);
		return cached;
	}

	public async loadTemplateFromVault(
		vaultPath: string,
	): Promise<string | null> {
		const normalizedPath = normalizePath(vaultPath);
		const file = this.vault.getAbstractFileByPath(normalizedPath);
		if (file instanceof TFile) return this.vault.read(file);
		logger.warn(
			`TemplateManager: Custom template file not found: "${vaultPath}"`,
		);
		return null;
	}

	public render(templateString: string, data: TemplateData): string {
		const compiled = this.compile(templateString);
		return compiled(data).trim();
	}

	async ensureTemplates(): Promise<void> {
		const templateDir = normalizePath(
			this.plugin.settings.template.templateDir || DEFAULT_TEMPLATES_FOLDER,
		);

		try {
			// Await the folder creation.
			await ensureFolderExists(this.vault, templateDir);
		} catch (err) {
			// If we can't even create the directory, we can't proceed.
			logger.error(
				`TemplateManager: Failed to create template directory at ${templateDir}`,
				err,
			);
			new Notice(`Failed to create template directory: ${templateDir}`);
			return; // Exit the function.
		}

		// Load built-in templates if they haven't been already.
		if (this.builtInTemplates.size === 0) {
			await this.loadBuiltInTemplates();
		}

		// Now that we are sure the directory exists, we can safely write the files.
		const writePromises = Array.from(this.builtInTemplates.values()).map(
			async (template) => {
				const filePath = normalizePath(`${templateDir}/${template.id}.md`);

				// Check if the file already exists to avoid unnecessary writes.
				if (!(await this.vault.adapter.exists(filePath))) {
					logger.info(
						`TemplateManager: Creating built-in template file: ${filePath}`,
					);
					const fileContent = `---\ndescription: ${template.description}\n---\n\n${template.content}`;

					try {
						await this.vault.create(filePath, fileContent);
					} catch (writeError) {
						logger.error(
							`TemplateManager: Failed to write template file ${filePath}`,
							writeError,
						);
					}
				}
			},
		);

		// Wait for all file writes to complete.
		await Promise.all(writePromises);
	}

	clearCache(): void {
		this.rawTemplateCache.clear();
		this.compiledTemplateCache.clear();
		logger.info("TemplateManager: TemplateManager caches cleared.");
	}

	public renderGroup(
		compiledFn: CompiledTemplate,
		group: Annotation[],
		ctx: RenderContext,
	): string {
		const head = group[0];
		const data: TemplateData = {
			pageno: head.pageno ?? 0,
			date: formatDate(head.datetime), // Stable en-US date
			localeDate: formatDateLocale(head.datetime), // User's system locale date
			dailyNoteLink: formatDateAsDailyNote(head.datetime), // [[YYYY-MM-DD]] link
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
		return compiledFn(data);
	}

	private mergeHighlightText(
		group: Annotation[],
		separators: (" " | " [...] ")[],
	): string {
		if (group.length === 0) {
			return "";
		}

		// First, style each annotation individually. `styleHighlight` already handles
		// internal paragraphs correctly with `<br><br>`.
		const styledHighlights = group.map((ann) =>
			styleHighlight(ann.text ?? "", ann.color, ann.drawer),
		);

		if (styledHighlights.length === 1) {
			return styledHighlights[0];
		}

		// Now, join the already-styled highlights with the correct inter-highlight separator.
		let result = styledHighlights[0];

		for (let i = 1; i < styledHighlights.length; i++) {
			const separator = separators[i - 1]; // Separator between (i-1) and (i)

			if (separator === " ") {
				// Contiguous highlights, just join with a space.
				result += " " + styledHighlights[i];
			} else {
				// A significant gap exists. Use a visual separator with paragraph breaks.
				// The <br><br> ensures a blank line appears.
				result += `<br><br>[...]<br><br>` + styledHighlights[i];
			}
		}

		return result;
	}

	private mergeNotes(group: Annotation[]): string {
		const notes = group
			.map((g) => g.note)
			.filter((n): n is string => typeof n === "string" && n.trim() !== "");
		if (!notes.length) return "";
		return notes.join("\n\n---\n\n");
	}
}
