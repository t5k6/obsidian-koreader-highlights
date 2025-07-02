import { normalizePath, Notice, TFile, type Vault } from "obsidian";
import type { Annotation, KoreaderHighlightImporterSettings } from "../types";
import { ensureFolderExists, handleFileSystemError } from "../utils/fileUtils";
import { parsePosition, styleHighlight } from "../utils/formatUtils";
import { devError, devLog, devWarn } from "../utils/logging";

export interface TemplateData {
    [key: string]: string | boolean | number | undefined;
    highlight?: string;
    chapter?: string;
    pageno?: number;
    isFirstInChapter?: boolean;
    note?: string;
    date?: string;
}

interface TemplateValidationResult {
    isValid: boolean;
    missingVariables: string[];
    syntaxIssues: string[];
}

export const BUILT_IN_TEMPLATES: Record<
    string,
    { version: string; description: string; content: string }
> = {
    default: {
        version: "1.0",
        description:
            "Default style: Chapter heading (optional), metadata, styled highlight, note (optional).",
        content: `{{#isFirstInChapter}}## {{chapter}}{{/isFirstInChapter}}

*Page {{pageno}} | {{date}}*
{{highlight}}
{{#note}}
> [!NOTE] Note
> {{note}}{{/note}}`,
    },
    enhanced: {
        version: "1.0",
        description: "Default style with added CSS classes for customization.",
        content: `{{#isFirstInChapter}}## {{chapter}}{{/isFirstInChapter}}
<div class="koreader-highlight-block">
  <span class="koreader-metadata">Page {{pageno}} • {{date}}</span>
  <p class="koreader-highlight-text">{{highlight}}</p>
  {{#note}}
  > [!NOTE] Note
  > {{note}}
  {{/note}}
</div>`,
    },
    "compact-list": {
        version: "1.0",
        description: "Uses a definition list for a more compact view.",
        content: `{{#isFirstInChapter}}### {{chapter}}{{/isFirstInChapter}}
<dl class="koreader-compact-item">
  <dt class="koreader-compact-meta">Page {{pageno}} ({{date}})</dt>
  <dd class="koreader-compact-highlight">{{highlight}}</dd>
  {{#note}}
  <dd class="koreader-compact-note">Note: {{note}}</dd>
  {{/note}}
</dl>`,
    },
    blockquote: {
        version: "1.0",
        description: "Formats the highlight as a blockquote.",
        content: `{{#isFirstInChapter}}### {{chapter}}{{/isFirstInChapter}}
<div class="koreader-quote-block">
> {{highlight}}
> <span class="koreader-quote-meta">— Page {{pageno}}, {{date}}</span>
{{#note}}
> [!NOTE] Note
> {{note}}
{{/note}}
</div>`,
    },
};

export const FALLBACK_TEMPLATE = BUILT_IN_TEMPLATES.default.content;
const TEMPLATE_DIR = "KOReader/templates";
const DARK_THEME_CLASS = "theme-dark";

export class TemplateManager {
    private isDarkTheme: boolean;
    private templateCache: Map<string, string> = new Map();
    private readonly REQUIRED_VARIABLES = ["highlight", "pageno"];

    constructor(
        private vault: Vault,
        private settings: KoreaderHighlightImporterSettings,
        isDarkTheme?: boolean,
    ) {
        this.isDarkTheme =
            isDarkTheme ?? document.body.classList.contains(DARK_THEME_CLASS);
        devLog(`TemplateManager initialized. Dark theme: ${this.isDarkTheme}`);
    }

    updateSettings(newSettings: KoreaderHighlightImporterSettings): void {
        const templateChanged =
            this.settings.template.selectedTemplate !==
                newSettings.template.selectedTemplate ||
            this.settings.template.useCustomTemplate !==
                newSettings.template.useCustomTemplate ||
            this.settings.template.source !== newSettings.template.source;

        this.settings = newSettings;

        if (templateChanged) {
            this.clearCache();
            devLog("Template settings changed, cache cleared.");
        }
    }

    private validateTemplate(content: string): TemplateValidationResult {
        // 1. Check for required variables
        const missingVariables = this.REQUIRED_VARIABLES.filter((variable) => {
            const regex = new RegExp(`{{${variable}}}|{{#${variable}}}`);
            return !regex.test(content);
        });

        // 2. Check for syntax issues like unclosed blocks
        const syntaxIssues: string[] = [];
        const openTags = content.match(/{{#(\w+)}}/g) || [];
        const closeTags = content.match(/{{\/\w+}}/g) || [];

        if (openTags.length !== closeTags.length) {
            syntaxIssues.push(
                `Mismatched conditional blocks. Found ${openTags.length} opening tags (e.g., {{#note}}) but ${closeTags.length} closing tags (e.g., {{/note}}).`,
            );
        }

        return {
            isValid: missingVariables.length === 0 && syntaxIssues.length === 0,
            missingVariables,
            syntaxIssues,
        };
    }

    async loadTemplate(): Promise<string> {
        const { template: templateSettings } = this.settings;

        if (!templateSettings.useCustomTemplate) {
            devLog("Using built-in default template.");
            return BUILT_IN_TEMPLATES.default.content;
        }

        const templateId = templateSettings.selectedTemplate;
        if (!templateId) {
            devWarn(
                "Custom template enabled but no template selected. Using default.",
            );
            return FALLBACK_TEMPLATE;
        }

        // Check cache first
        const cachedTemplate = this.templateCache.get(templateId);
        if (cachedTemplate) {
            devLog(`Using cached template: ${templateId}`);
            return cachedTemplate;
        }

        let templateContent = await this.loadTemplateContent(
            templateId,
            templateSettings.source,
        );

        // Validate and fallback if necessary
        if (templateContent) {
            const validation = this.validateTemplate(templateContent);
            if (!validation.isValid) {
                if (validation.missingVariables.length > 0) {
                    devWarn(
                        `Template "${templateId}" missing required variables: ${validation.missingVariables.join(
                            ", ",
                        )}.`,
                    );
                }
                if (validation.syntaxIssues.length > 0) {
                    devWarn(
                        `Template "${templateId}" has syntax errors: ${validation.syntaxIssues.join(
                            ", ",
                        )}.`,
                    );
                }
                templateContent = FALLBACK_TEMPLATE;
            }
        } else {
            templateContent = FALLBACK_TEMPLATE;
        }

        this.templateCache.set(templateId, templateContent);
        return templateContent;
    }

    private async loadTemplateContent(
        templateId: string,
        source: string,
    ): Promise<string | null> {
        try {
            if (source === "vault" || !source) {
                return await this.loadFromVault(templateId);
            }
            // Handle other sources here if needed
            return null;
        } catch (error) {
            handleFileSystemError("loading template", templateId, error);
            return null;
        }
    }

    private async loadFromVault(templateId: string): Promise<string | null> {
        if (templateId.match(/[<>:"|?*]/)) {
            // Check for invalid characters
            devWarn(`Invalid template path: "${templateId}"`);
            new Notice(
                `Invalid template path: ${templateId}. Using default template.`,
            );
            return null;
        }
        const vaultPath = normalizePath(templateId);
        const file = this.vault.getAbstractFileByPath(vaultPath);

        if (file instanceof TFile) {
            const content = await this.vault.read(file);
            devLog(`Loaded template from vault: ${vaultPath}`);
            return content;
        }

        // Fallback to built-in template
        if (BUILT_IN_TEMPLATES[templateId]) {
            devLog(`Using built-in template: ${templateId}`);
            return BUILT_IN_TEMPLATES[templateId].content;
        }

        devWarn(`Template not found: "${vaultPath}"`);
        return null;
    }

    renderHighlight(
        template: string,
        data: TemplateData,
        annotations: Annotation[],
    ): string {
        // Filter out annotations with empty text
        const validAnnotations = annotations.filter(
            (ann) => ann.text && ann.text.trim() !== "",
        );

        if (validAnnotations.length === 0) {
            devLog("No valid annotations to render");
            return "";
        }

        try {
            // Handle highlight styling and combination
            if (validAnnotations.length === 1) {
                const [annotation] = validAnnotations;
                data.highlight = this.styleSingleHighlight(
                    annotation.text || "",
                    annotation.color,
                    annotation.drawer,
                );
            } else {
                data.highlight = this.combineAndStyleGroup(validAnnotations);

                // Fallback if combined highlight is empty
                if (!data.highlight.trim()) {
                    devWarn("All highlights in group were empty after styling");
                    data.highlight = "Highlight content not available";
                }
            }

            let output = this.processConditionalBlocks(template, data);
            output = this.processSimpleVariables(output, data);
            return this.cleanupOutput(output);
        } catch (error) {
            devError(
                "Error rendering highlight template. Returning unformatted fallback.",
                error,
            );
            // Return a safe, unformatted version of the highlight
            return `*Page ${data.pageno} | ${data.date}*\n${data.highlight}\n\n`;
        }
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
                        shouldRender = value.trim() !== ""; // Don't render for empty strings
                    } else {
                        shouldRender = value !== null && value !== undefined;
                    }

                    if (key === "isFirstInChapter" && !data.chapter?.trim()) {
                        shouldRender = false;
                    }

                    return shouldRender ? content : "";
                },
            );
        } while (processedTemplate !== lastTemplate); // Loop until no more changes are made.

        return processedTemplate;
    }

    private processHighlightStyling(
        template: string,
        data: TemplateData,
        color?: string,
        drawer?: Annotation["drawer"],
    ): string {
        const highlightText = data.highlight?.toString() ?? "";
        if (!highlightText) {
            return template.replace("{{highlight}}", "");
        }

        const styledHighlight = styleHighlight(
            highlightText,
            color,
            drawer,
            this.isDarkTheme,
        );
        return template.replace("{{highlight}}", styledHighlight);
    }

    private processSimpleVariables(
        template: string,
        data: TemplateData,
    ): string {
        return template.replace(/\{\{((?!#|\/)[\w]+)\}\}/g, (_, key) => {
            if (key === "note" && typeof data.note === "string") {
                // Prefix every line with '> ' for blockquote
                return data.note
                    .split("\n")
                    .map((line) => `> ${line}`)
                    .join("\n");
            }
            return data[key]?.toString() ?? "";
        });
    }

    private cleanupOutput(output: string): string {
        if (!output.trim()) return "";

        // Special handling: preserve blockquotes (lines starting with '> ')
        const lines = output.split(/\r?\n/);
        let inBlockquote = false;
        const cleanedLines: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith("> ")) {
                inBlockquote = true;
                cleanedLines.push(line); // preserve as-is
            } else if (inBlockquote && line.trim() === "") {
                // preserve blank lines inside blockquote
                cleanedLines.push(line);
            } else {
                inBlockquote = false;
                // For non-blockquote, trim and skip multiple blank lines
                if (
                    line.trim() !== "" ||
                    (cleanedLines.length > 0 &&
                        cleanedLines[cleanedLines.length - 1].trim() !== "")
                ) {
                    cleanedLines.push(line.trim());
                }
            }
        }

        // Remove leading/trailing blank lines
        while (cleanedLines.length && cleanedLines[0].trim() === "") {
            cleanedLines.shift();
        }
        while (
            cleanedLines.length &&
            cleanedLines[cleanedLines.length - 1].trim() === ""
        )
            cleanedLines.pop();

        return cleanedLines.join("\n") + "\n";
    }

    async ensureTemplates(): Promise<void> {
        const templateDir = normalizePath(
            this.settings.template.templateDir || "KOReader/templates",
        );

        try {
            await ensureFolderExists(this.vault, templateDir);
        } catch (err) {
            // ensureFolderExists already surfaced a Notice; just stop here.
            return;
        }

        await this.createMissingTemplateFiles(templateDir);
    }

    private async createMissingTemplateFiles(
        templateDir: string,
    ): Promise<void> {
        for (const [name, templateData] of Object.entries(BUILT_IN_TEMPLATES)) {
            const filePath = normalizePath(`${templateDir}/${name}.md`);
            const fileExists = await this.vault.adapter.exists(filePath);

            if (!fileExists) {
                devLog(`Creating template file: ${filePath}`);
                await this.vault.create(filePath, templateData.content);
            }
        }
    }

    clearCache(): void {
        this.templateCache.clear();
        devLog("TemplateManager cache cleared.");
    }

    private styleSingleHighlight(
        text: string,
        color?: string,
        drawer?: Annotation["drawer"],
    ): string {
        return styleHighlight(text, color, drawer, this.isDarkTheme);
    }

    private combineAndStyleGroup(annotations: Annotation[]): string {
        const sorted = [...annotations].sort((a, b) => {
            const posA = parsePosition(a.pos0);
            const posB = parsePosition(b.pos0);
            return (posA?.offset || 0) - (posB?.offset || 0);
        });

        let combined = "";
        let lastNonEmptyIndex = -1;

        for (let i = 0; i < sorted.length; i++) {
            const current = sorted[i];
            const text = current.text || "";

            // Skip empty highlights
            if (!text.trim()) continue;

            const styled = this.styleSingleHighlight(
                text,
                current.color,
                current.drawer,
            );

            // Skip if styling returned empty
            if (!styled.trim()) continue;

            // Add separator if needed
            if (lastNonEmptyIndex >= 0) {
                const prev = sorted[lastNonEmptyIndex];
                const gap = this.calculateGap(prev, current);
                if (gap > 5) combined += " [...] ";
                else if (gap > 0) combined += " ";
            }

            // Add current highlight
            combined += styled;
            lastNonEmptyIndex = i;
        }

        return combined;
    }

    private calculateGap(prev: Annotation, current: Annotation): number {
        const posPrev = parsePosition(prev.pos1);
        const posCurr = parsePosition(current.pos0);

        if (!posPrev || !posCurr) return Infinity;
        if (posPrev.node !== posCurr.node) return Infinity;

        return posCurr.offset - posPrev.offset;
    }
}
