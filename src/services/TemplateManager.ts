import { normalizePath, TFile, type Vault } from "obsidian";
import type { Annotation, KoReaderHighlightImporterSettings } from "../types";
import { handleFileSystemError } from "../utils/fileUtils";
import {
    getContrastTextColor,
    KOReaderHighlightColors,
} from "../utils/formatUtils";
import { devError, devLog, devWarn } from "../utils/logging";

const BUILT_IN_TEMPLATES: Record<
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

const FALLBACK_TEMPLATE = BUILT_IN_TEMPLATES.default.content;

export class TemplateManager {
    private isDarkTheme: boolean;
    private templateCache: Map<string, string> = new Map();

    constructor(
        private vault: Vault,
        private settings: KoReaderHighlightImporterSettings,
    ) {
        this.isDarkTheme = document.body.classList.contains("theme-dark");
        devLog(
            `TemplateManager initialized. Dark theme detected: ${this.isDarkTheme}`,
        );
    }

    updateSettings(newSettings: KoReaderHighlightImporterSettings): void {
        const oldTemplateSelection = this.settings.template.selectedTemplate;
        this.settings = newSettings;
        // Clear cache if template selection/source changed
        if (this.settings.template.selectedTemplate !== oldTemplateSelection) {
            this.clearCache();
            devLog("Template settings changed, cache cleared.");
        }
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
                "Custom template enabled but no template selected. Falling back to default.",
            );
            return FALLBACK_TEMPLATE;
        }

        const cachedTemplate = this.templateCache.get(templateId);
        if (cachedTemplate) {
            devLog(`Using cached template: ${templateId}`);
            return cachedTemplate;
        }

        let templateContent: string | null = null;

        try {
            if (
                templateSettings.source === "vault" || !templateSettings.source
            ) {
                const vaultPath = normalizePath(templateId);
                const file = this.vault.getAbstractFileByPath(vaultPath);
                if (file instanceof TFile) {
                    templateContent = await this.vault.read(file);
                    devLog(`Loaded template from vault: ${vaultPath}`);
                } else {
                    if (BUILT_IN_TEMPLATES[templateId]) {
                        templateContent =
                            BUILT_IN_TEMPLATES[templateId].content;
                        devLog(`Using built-in template: ${templateId}`);
                    } else {
                        devWarn(
                            `Template not found in vault at "${vaultPath}" and not a known built-in template.`,
                        );
                    }
                }
            }
        } catch (error) {
            handleFileSystemError(
                "loading template from vault",
                normalizePath(templateId),
                error,
            );
        }

        if (!templateContent) {
            devWarn(
                `Failed to load template "${templateId}". Falling back to default template.`,
            );
            templateContent = FALLBACK_TEMPLATE;
        }

        this.templateCache.set(templateId, templateContent);
        return templateContent;
    }

    renderHighlight(
        template: string,
        data: Record<string, string | boolean | number | undefined>,
        color?: string,
        drawer?: Annotation["drawer"],
    ): string {
        let output = template;

        // 1. Handle conditional blocks: {{#key}}...{{/key}}
        output = output.replace(
            /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
            (_, key, content) => {
                const flagValue = data[key];
                const shouldRender = (key === "isFirstInChapter")
                    ? flagValue === true
                    : !!flagValue; // True for non-empty strings, true bools, non-zero numbers

                if (shouldRender) {
                    // Process nested variables *within* the block content
                    return content.replace(
                        /\{\{(\w+)\}\}/g,
                        (__: string, innerKey: string) => {
                            return data[innerKey]?.toString() ?? ""; // Replace inner vars like {{chapter}} or {{note}}
                        },
                    );
                }
                return ""; // Remove the block if condition is false
            },
        );

        // 2. Style the {{highlight}} placeholder text based on color/drawer
        let styledHighlight = data.highlight?.toString() ?? ""; // Ensure we have a string
        if (styledHighlight) { // Only apply styling if there's text
            const lowerColor = color?.toLowerCase().trim();
            const colorHex = lowerColor
                ? (KOReaderHighlightColors[lowerColor] || color)
                : null; // Use hex from map or direct color if not in map

            switch (drawer) {
                case "underscore":
                    styledHighlight = `<u>${styledHighlight}</u>`;
                    break;
                case "strikeout":
                    styledHighlight = `<s>${styledHighlight}</s>`;
                    break;
                case "invert":
                    if (colorHex && lowerColor !== "gray") {
                        // Invert: background is text color, text is background color
                        const textColor = getContrastTextColor(
                            colorHex,
                            this.isDarkTheme,
                        );
                        styledHighlight =
                            `<mark style="background-color: ${textColor}; color: ${colorHex}">${styledHighlight}</mark>`;
                    }
                    // No styling change for gray or if no valid color
                    break;
                // case 'lighten': // TODO: Implement specific 'lighten' style if different from default mark
                default: // Default is 'lighten' or no drawer specified
                    if (colorHex && lowerColor !== "gray") {
                        const textColor = getContrastTextColor(
                            colorHex,
                            this.isDarkTheme,
                        );
                        styledHighlight =
                            `<mark style="background-color: ${colorHex}; color: ${textColor}">${styledHighlight}</mark>`;
                    }
                    // No styling change for gray or if no valid color
                    break;
            }
        }
        output = output.replace("{{highlight}}", styledHighlight);

        // 3. Replace remaining simple variables: {{key}}
        output = output.replace(/\{\{((?!#|\/)\w+)\}\}/g, (_, key) => {
            // Avoid replacing keys already handled by conditionals if they somehow remain
            // (e.g., if {{note}} exists outside {{#note}} block)
            if (key === "highlight") return ""; // Already replaced

            return data[key]?.toString() ?? ""; // Use empty string for missing values
        });

        // 4. Cleanup potentially empty lines / excessive newlines
        // output = output.replace("## ", "")
        output = output.split(/[\r\n]+/).map((line) => {
            // If the line was, for example, "## " and then {{chapter}} was removed,
            // it might become "## ". This regex handles that.
            // Or if a conditional block was removed entirely.
            return line.trim() === "" || /^#+\s*$/.test(line.trim())
                ? ""
                : line;
        }).filter((line) => line !== "").join("\n"); // Join non-empty lines (excluding empty strings but keeping newlines)
        output = output.replace(/\n{3,}/g, "\n\n"); // Consolidate multiple newlines

        output = output.trim();
        if (output.length > 0) {
            output = output.replace(/\n+$/, "") + "\n";
        }
        return output;
    }

    async ensureTemplates(): Promise<void> {
        const templateDir = normalizePath("Koreader/templates");

        try {
            const folderExists = await this.vault.adapter.exists(templateDir);
            if (!folderExists) {
                devLog(`Creating template directory: ${templateDir}`);
                await this.vault.createFolder(templateDir);
            } else {
                const folderStat = await this.vault.adapter.stat(templateDir);
                if (!folderStat || folderStat.type !== "folder") {
                    devError(
                        `Expected folder at ${templateDir}, but found something else. Cannot ensure templates.`,
                    );
                    return;
                }
            }

            for (
                const [name, templateData] of Object.entries(BUILT_IN_TEMPLATES)
            ) {
                const filePath = normalizePath(`${templateDir}/${name}.md`);
                const fileExists = await this.vault.adapter.exists(filePath);

                if (!fileExists) {
                    devLog(`Creating default template file: ${filePath}`);
                    await this.vault.create(filePath, templateData.content);
                }
            }
        } catch (error) {
            handleFileSystemError(
                "ensuring default templates",
                templateDir, // or filePath if more specific
                error,
                // shouldThrow might be false here, as plugin can function with default built-in template
                {
                    customNoticeMessage:
                        "Failed to create/access default KoReader templates.",
                },
            );
        }
    }

    clearCache(): void {
        this.templateCache.clear();
        devLog("TemplateManager cache cleared.");
    }
}
