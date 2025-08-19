import { debounce, normalizePath, parseYaml, type Vault } from "obsidian";
import { DEFAULT_TEMPLATES_FOLDER } from "src/constants";
import type { IterableCache } from "src/lib/cache";
import type { CacheManager } from "src/lib/cache/CacheManager";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type { TemplateFailure } from "src/lib/errors";
import {
	extractFrontmatter,
	stripFrontmatter,
} from "src/lib/frontmatter/frontmatterUtils";
import { isTFile } from "src/lib/obsidian/typeguards";
import {
	compile as compileTemplate,
	validateTemplate as engineValidate,
} from "src/lib/template/templateCore";
import type KoreaderImporterPlugin from "src/main";
import type {
	KoreaderHighlightImporterSettings,
	SettingsObserver,
	TemplateData,
	TemplateDefinition,
} from "src/types";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";

export const FALLBACK_TEMPLATE_ID = "default";
const DARK_THEME_CLASS = "theme-dark";

/** Injected by esbuild.define (see esbuild.config.js) */
declare const KOREADER_BUILTIN_TEMPLATES: string;

export type CompiledTemplate = (data: TemplateData) => string;

// Validation result type re-exported from engine via import above

export class TemplateManager implements SettingsObserver {
	private readonly log;
	private isDarkTheme: boolean = true;
	private rawTemplateCache: IterableCache<string, string>;
	private compiledTemplateCache: IterableCache<string, CompiledTemplate>;
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

		// Invalidate template caches when the selected custom template file is modified or deleted.
		this.plugin.registerEvent(
			this.plugin.app.vault.on("modify", (file) => {
				const { useCustomTemplate, selectedTemplate } =
					this.plugin.settings.template;
				if (!useCustomTemplate) return;
				const normalized = normalizePath(selectedTemplate || "");
				if (file.path === normalized) {
					this.cacheManager.clear("template.*");
					this.log.info(`Template file modified; cleared template caches.`);
				}
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.vault.on("delete", (file) => {
				const { useCustomTemplate, selectedTemplate } =
					this.plugin.settings.template;
				if (!useCustomTemplate) return;
				const normalized = normalizePath(selectedTemplate || "");
				if (file.path === normalized) {
					this.cacheManager.clear("template.*");
					this.log.info(`Template file deleted; cleared template caches.`);
				}
			}),
		);
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
	 * Single source of truth for template cache key generation.
	 */
	private cacheKey(): string {
		const { useCustomTemplate, selectedTemplate } =
			this.plugin.settings.template;
		const id = selectedTemplate || FALLBACK_TEMPLATE_ID;
		return useCustomTemplate ? id : `builtin_${id}`;
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
				const fmContent = extractFrontmatter(content);
				let description = `The ${name} template.`;
				if (fmContent) {
					try {
						const fm = parseYaml(fmContent) ?? {};
						if (
							typeof (fm as any).description === "string" &&
							(fm as any).description.trim()
						) {
							description = (fm as any).description.trim();
						}
					} catch {
						// ignore parse errors; keep default description
					}
				}
				const templateContent = stripFrontmatter(content);
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
	 * Purely loads and validates the current template (built-in or custom) as a Result.
	 * Performs no logging, fallbacks, or side effects. Callers are responsible for handling Err cases.
	 */
	public async loadTemplateResult(): Promise<Result<string, TemplateFailure>> {
		await this.loadBuiltInTemplates();
		const { useCustomTemplate, selectedTemplate } =
			this.plugin.settings.template;
		const templateId = selectedTemplate || FALLBACK_TEMPLATE_ID;

		const contentRes = !useCustomTemplate
			? this._getBuiltInTemplateContent(templateId)
			: await this._loadCustomTemplateContent(templateId);

		if (isErr(contentRes)) return contentRes;

		const rawContent = useCustomTemplate
			? stripFrontmatter(contentRes.value)
			: contentRes.value;

		const validation = engineValidate(rawContent);
		if (!validation.isValid) {
			return err({
				kind: "TemplateInvalid",
				id: templateId,
				errors: validation.errors,
			});
		}

		return ok(rawContent);
	}

	/**
	 * Purely gets a compiled version of the current template as a Result.
	 * Performs no logging or fallbacks. Caches the compiled function on success.
	 */
	public async getCompiledTemplateResult(): Promise<
		Result<CompiledTemplate, TemplateFailure>
	> {
		const cacheKey = this.cacheKey();
		const cached = this.compiledTemplateCache.get(cacheKey);
		if (cached) return ok(cached);

		const rawResult = await this.loadTemplateResult();
		if (isErr(rawResult)) return rawResult;

		const compiledFn = compileTemplate(rawResult.value);
		this.compiledTemplateCache.set(cacheKey, compiledFn);
		return ok(compiledFn);
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

		// Ensure the directory exists using Result-based API.
		const ensured = await this.fs.ensureVaultFolder(templateDir);
		if (isErr(ensured)) {
			this.log.error(
				`Failed to create template directory at ${templateDir}`,
				(ensured as any).error ?? ensured,
			);
			return;
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
				const existsRes = await this.fs.vaultExists(filePath);
				if (isErr(existsRes) || !existsRes.value) {
					this.log.info(`Creating built-in template file: ${filePath}`);
					const fileContent = `---\ndescription: ${template.description}\n---\n\n${template.content}`;

					const res = await this.fs.writeVaultTextAtomic(filePath, fileContent);
					if (isErr(res)) {
						this.log.error(
							`Failed to write template file ${filePath}`,
							(res as any).error ?? res,
						);
					}
				}
			},
		);

		// Wait for all file writes to complete.
		await Promise.all(writePromises);
	}

	/** [private] Purely retrieves built-in template content. */
	private _getBuiltInTemplateContent(
		id: string,
	): Result<string, TemplateFailure> {
		const builtIn = this.builtInTemplates.get(id);
		if (!builtIn) {
			return err({ kind: "TemplateNotFound", path: `builtin:${id}` });
		}
		return ok(builtIn.content);
	}

	/** [private] Purely loads custom template content from the vault. */
	private async _loadCustomTemplateContent(
		vaultPath: string,
	): Promise<Result<string, TemplateFailure>> {
		const normalizedPath = normalizePath(vaultPath);
		const file = this.vault.getAbstractFileByPath(normalizedPath);
		if (!isTFile(file)) {
			return err({ kind: "TemplateNotFound", path: vaultPath });
		}
		const content = await this.vault.read(file);
		return ok(content);
	}
}
