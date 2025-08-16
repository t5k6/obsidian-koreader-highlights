import { debounce, Notice, normalizePath, TFile, type Vault } from "obsidian";
import { DEFAULT_TEMPLATES_FOLDER } from "src/constants";
import type { CacheManager } from "src/lib/cache/CacheManager";
import type { LruCache } from "src/lib/cache/LruCache";
import {
	formatDate,
	formatDateAsDailyNote,
	formatDateLocale,
} from "src/lib/formatting/dateUtils";
import { styleHighlight } from "src/lib/formatting/highlightStyle";
import type KoreaderImporterPlugin from "src/main";
import type {
	Annotation,
	KoreaderHighlightImporterSettings,
	RenderContext,
	SettingsObserver,
	TemplateData,
	TemplateDefinition,
} from "src/types";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import { TemplateValidator } from "./TemplateValidator";

export const FALLBACK_TEMPLATE_ID = "default";
const DARK_THEME_CLASS = "theme-dark";

const NOTE_LINE_REGEX = /^\s*>\s*/;
const TEMPLATE_FRONTMATTER_REGEX = /^---.*?---\s*/s;
/** Injected by esbuild.define (see esbuild.config.js) */
declare const KOREADER_BUILTIN_TEMPLATES: string;

export type CompiledTemplate = (data: TemplateData) => string;
type TemplateToken =
	| { type: "text"; value: string }
	| { type: "var"; key: string }
	| { type: "cond"; key: string; body: TemplateToken[] };

const MAX_TEMPLATE_NESTING = 20;

export interface TemplateValidationResult {
	isValid: boolean;
	errors: string[];
	warnings: string[];
	suggestions: string[];
}

export class TemplateManager implements SettingsObserver {
	private readonly log;
	private isDarkTheme: boolean = true;
	private rawTemplateCache: LruCache<string, string>;
	private compiledTemplateCache: LruCache<string, CompiledTemplate>;
	private readonly updateThemeDebounced: (() => void) & { cancel: () => void };
	public builtInTemplates: Map<string, TemplateDefinition> = new Map();

	constructor(
		public plugin: KoreaderImporterPlugin,
		private vault: Vault,
		private cacheManager: CacheManager,
		private fs: FileSystemService,
		private loggingService: LoggingService,
	) {
		this.rawTemplateCache = cacheManager.createLru("template.raw", 10);
		this.compiledTemplateCache = cacheManager.createLru(
			"template.compiled",
			10,
		);

		this.log = this.loggingService.scoped("TemplateManager");

		this.updateTheme = this.updateTheme.bind(this);
		this.updateThemeDebounced = debounce(this.updateTheme, 250, false) as any;
		this.updateTheme();
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("css-change", this.updateThemeDebounced),
		);
		this.log.info(`Initialized. Dark theme: ${this.isDarkTheme}`);
	}

	public onSettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
		oldSettings: KoreaderHighlightImporterSettings,
	): void {
		const templateChanged =
			oldSettings.template.useCustomTemplate !==
				newSettings.template.useCustomTemplate ||
			oldSettings.template.selectedTemplate !==
				newSettings.template.selectedTemplate ||
			oldSettings.template.templateDir !== newSettings.template.templateDir;

		if (templateChanged) {
			this.cacheManager.clear("template.*");
			this.log.info("Template settings changed, relevant caches cleared.");
		}
	}

	/**
	 * Updates the cached theme state when the Obsidian theme changes.
	 * Monitors for dark/light theme switches to adjust rendering if needed.
	 */
	private updateTheme(): void {
		const newThemeState = document.body.classList.contains(DARK_THEME_CLASS);
		if (this.isDarkTheme !== newThemeState) {
			this.isDarkTheme = newThemeState;
			this.log.info(`Theme changed. Dark theme: ${this.isDarkTheme}`);
			// Only clear compiled templates if they actually depend on theme differences
			if (this.hasThemeDependentTemplates()) {
				this.compiledTemplateCache.clear();
				this.log.info("Cleared compiled template cache due to theme change.");
			}
		}
	}

	/**
	 * Returns true if the currently selected templates produce theme-dependent output
	 * requiring recompilation on theme changes. This is a conservative hook; adjust
	 * when templates introduce theme-conditional logic.
	 */
	private hasThemeDependentTemplates(): boolean {
		// Current templates do not embed theme-conditional logic at compile-time.
		// Rendering relies on CSS variables, so recompilation is unnecessary.
		return false;
	}

	/**
	 * Tokenizes a template string into a sequence of tokens without executing code.
	 * Supports text, variables {{var}}, and simple conditionals {{#key}}...{{/key}}.
	 * Recursion depth is limited to prevent pathological nesting.
	 */
	private tokenizeTemplate(
		template: string,
		depth: number = 0,
	): TemplateToken[] {
		if (depth > MAX_TEMPLATE_NESTING) {
			// Exceeded nesting; treat the whole string as text to avoid stack/DoS
			return [{ type: "text", value: template }];
		}

		const tokens: TemplateToken[] = [];
		let i = 0;
		const len = template.length;

		const pushText = (text: string) => {
			if (text) tokens.push({ type: "text", value: text });
		};

		while (i < len) {
			const open = template.indexOf("{{", i);
			if (open === -1) {
				pushText(template.slice(i));
				break;
			}
			if (open > i) pushText(template.slice(i, open));

			const isCondOpen = template.startsWith("{{#", open);
			const isClose = template.startsWith("{{/", open);
			const end = template.indexOf("}}", open + 2);
			if (end === -1) {
				// Unclosed tag: treat remainder as text
				pushText(template.slice(open));
				break;
			}

			if (isCondOpen) {
				const key = template.slice(open + 3, end).trim();
				const after = end + 2;
				const closeTag = `{{/${key}}}`;
				const closeIdx = template.indexOf(closeTag, after);
				if (closeIdx === -1) {
					// No closing tag; treat as text
					pushText(template.slice(open, end + 2));
					i = end + 2;
					continue;
				}
				const inner = template.slice(after, closeIdx);
				const body = this.tokenizeTemplate(inner, depth + 1);
				tokens.push({ type: "cond", key, body });
				i = closeIdx + closeTag.length;
				continue;
			}

			if (isClose) {
				// Unbalanced close; treat literally
				pushText(template.slice(open, end + 2));
				i = end + 2;
				continue;
			}

			const name = template.slice(open + 2, end).trim();
			if (name && !name.startsWith("#") && !name.startsWith("/")) {
				tokens.push({ type: "var", key: name });
			} else {
				pushText(template.slice(open, end + 2));
			}
			i = end + 2;
		}

		return tokens;
	}

	/**
	 * Compiles a template string into an executable function.
	 * Handles variable substitution and conditional blocks.
	 * @param templateString - The raw template string
	 * @returns Compiled template function that accepts TemplateData
	 */
	public compile(templateString: string): CompiledTemplate {
		// Determine how to render note lines based on template usage
		const noteLineHasQuote = /^[ \t]*>[^\n]*\{\{note\}\}/m.test(templateString);
		const noteLines = templateString
			.split(/\r?\n/)
			.filter((l) => l.includes("{{note}}"));
		const userHandlesPrefix = noteLines.some((l) => NOTE_LINE_REGEX.test(l));
		const autoPrefixNotes = !userHandlesPrefix;

		const tokens = this.tokenizeTemplate(templateString);

		const renderNote = (raw: unknown): string => {
			const s = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
			if (!s) return "";
			const lines = s.split("\n");
			if (noteLineHasQuote) {
				return lines.map((l, idx) => (idx === 0 ? l : `> ${l}`)).join("\n");
			}
			if (autoPrefixNotes) {
				return lines.map((l) => `> ${l}`).join("\n");
			}
			return s;
		};

		const renderTokens = (ts: TemplateToken[], d: TemplateData): string => {
			let out = "";
			for (const t of ts) {
				if (t.type === "text") {
					out += t.value;
				} else if (t.type === "var") {
					if (t.key === "note") {
						out += renderNote((d as any).note);
					} else {
						const v = (d as any)[t.key];
						out += v == null ? "" : String(v);
					}
				} else if (t.type === "cond") {
					const cond = (d as any)[t.key];
					if (cond) out += renderTokens(t.body, d);
				}
			}
			return out;
		};

		return (d: TemplateData) => renderTokens(tokens, d);
	}

	/**
	 * Loads all built-in templates from the embedded JSON resource.
	 * Parses template metadata and stores them for user selection.
	 * @returns Promise that resolves when templates are loaded
	 */
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
			this.log.error("Failed to parse built-in templates.", error);
		}
		this.log.info(`Loaded ${this.builtInTemplates.size} built-in templates.`);
	}

	/**
	 * Validates a template to ensure it contains required variables.
	 * Checks for presence of {{highlight}} and {{pageno}} at minimum.
	 * @param content - The template content to validate
	 * @returns Validation result with errors, warnings, and suggestions
	 */
	public validateTemplate(content: string): TemplateValidationResult {
		const validator = new TemplateValidator();
		const v = validator.validate(content);
		// Preserve existing HTML warning behavior
		if (/<[a-z][\s\S]*>/i.test(content)) {
			v.warnings.push("HTML detected; may require custom CSS.");
		}
		return {
			isValid: v.isValid,
			errors: v.errors,
			warnings: v.warnings,
			suggestions: v.suggestions,
		};
	}

	/**
	 * Loads the currently selected template, either built-in or custom.
	 * Falls back to default template if selected template is invalid or missing.
	 * @returns Promise resolving to the template string content
	 */
	async loadTemplate(): Promise<string> {
		await this.loadBuiltInTemplates();
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
			this.log.error("Template validation failed:", validation.errors);
			templateContent =
				this.builtInTemplates.get(FALLBACK_TEMPLATE_ID)?.content ?? "";
		}

		this.rawTemplateCache.set(cacheKey, templateContent);
		return templateContent;
	}

	/**
	 * Gets the compiled version of the current template.
	 * Uses caching to avoid recompilation on repeated calls.
	 * @returns Promise resolving to the compiled template function
	 */
	public async getCompiledTemplate(): Promise<CompiledTemplate> {
		const { useCustomTemplate, selectedTemplate } =
			this.plugin.settings.template;
		const templateId = selectedTemplate || FALLBACK_TEMPLATE_ID;
		const cacheKey = useCustomTemplate ? templateId : `builtin_${templateId}`;

		const cached = this.compiledTemplateCache.get(cacheKey);
		if (cached) return cached;

		const rawTemplate = await this.loadTemplate();
		const compiledFn = this.compile(rawTemplate);

		this.compiledTemplateCache.set(cacheKey, compiledFn);
		return compiledFn;
	}

	/**
	 * Loads a custom template file from the vault.
	 * @param vaultPath - Path to the template file in the vault
	 * @returns Promise resolving to template content or null if not found
	 */
	public async loadTemplateFromVault(
		vaultPath: string,
	): Promise<string | null> {
		const normalizedPath = normalizePath(vaultPath);
		const file = this.vault.getAbstractFileByPath(normalizedPath);
		if (file instanceof TFile) return this.vault.read(file);
		this.log.warn(`Custom template file not found: "${vaultPath}"`);
		return null;
	}

	/**
	 * Renders a template string with the provided data.
	 * @param templateString - The template string to render
	 * @param data - The data object containing values for template variables
	 * @returns The rendered output string
	 */
	public render(templateString: string, data: TemplateData): string {
		const compiled = this.compile(templateString);
		return compiled(data).trim();
	}

	/**
	 * Ensures built-in templates exist in the vault's template directory.
	 * Creates the directory and template files if they don't exist.
	 * @returns Promise that resolves when all templates are in place
	 */
	async ensureTemplates(): Promise<void> {
		const templateDir = normalizePath(
			this.plugin.settings.template.templateDir || DEFAULT_TEMPLATES_FOLDER,
		);

		try {
			// Await the folder creation.
			await this.fs.ensureVaultFolder(templateDir);
		} catch (err) {
			// If we can't even create the directory, we can't proceed.
			this.log.error(
				`Failed to create template directory at ${templateDir}`,
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
				if (!(await this.fs.vaultExists(filePath))) {
					this.log.info(`Creating built-in template file: ${filePath}`);
					const fileContent = `---\ndescription: ${template.description}\n---\n\n${template.content}`;

					try {
						await this.vault.create(filePath, fileContent);
					} catch (writeError) {
						// Gracefully handle races where the file was created by another process
						// between our existence check and the create() call.
						const code = (writeError as NodeJS.ErrnoException)?.code;
						if (
							code === "EEXIST" ||
							(writeError instanceof Error &&
								/already exists/i.test(writeError.message))
						) {
							this.log.info(
								`Template file already exists (race handled): ${filePath}`,
							);
							return; // Skip logging as error
						}
						this.log.error(
							`Failed to write template file ${filePath}`,
							writeError,
						);
					}
				}
			},
		);

		// Wait for all file writes to complete.
		await Promise.all(writePromises);
	}

	/**
	 * Renders a group of annotations using the compiled template.
	 * Merges highlights and notes within the group based on context.
	 * @param compiledFn - The compiled template function
	 * @param group - Array of annotations to render together
	 * @param ctx - Render context with separators and chapter info
	 * @returns The rendered string for the annotation group
	 */
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

	/**
	 * Merges multiple highlight texts with appropriate separators.
	 * Handles styling and gap indicators between non-contiguous highlights.
	 * @param group - Array of annotations to merge
	 * @param separators - Array of separators (" " or " [...] ")
	 * @returns Merged and styled highlight text
	 */
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
				result += ` ${styledHighlights[i]}`;
			} else {
				// A significant gap exists. Use a visual separator with paragraph breaks.
				// Normalize any trailing breaks to avoid duplication.
				result = result.replace(/<br><br>$/, "");
				// The <br><br> ensures a blank line appears.
				result += `[...]${styledHighlights[i]}`;
			}
		}

		return result;
	}

	/**
	 * Merges notes from multiple annotations with dividers.
	 * @param group - Array of annotations containing notes
	 * @returns Merged notes separated by horizontal rules
	 */
	private mergeNotes(group: Annotation[]): string {
		const notes = group
			.map((g) => g.note)
			.filter((n): n is string => typeof n === "string" && n.trim() !== "");
		if (!notes.length) return "";
		return notes.join("\n---\n");
	}
}
