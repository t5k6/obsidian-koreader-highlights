import { Notice, normalizePath, type Setting } from "obsidian";
import { DEFAULT_TEMPLATES_FOLDER } from "src/constants";
import type KoreaderImporterPlugin from "src/main";
import type { TemplateManager } from "src/services/parsing/TemplateManager";
import type { TemplateDefinition } from "src/types";
import { PromptModal } from "src/ui/PromptModal";
import { TemplatePreviewModal } from "src/ui/TemplatePreviewModal";
import { renderSettingsSection, type SettingSpec } from "../SettingsKit";
import { SettingsSection } from "../SettingsSection";

export class TemplateSettingsSection extends SettingsSection {
	private readonly templateManager: TemplateManager;

	constructor(
		plugin: KoreaderImporterPlugin,
		debouncedSave: (() => void) & { cancel: () => void },
		title: string,
		templateManager: TemplateManager,
		startOpen = false,
	) {
		super(plugin, debouncedSave, title, startOpen);
		this.templateManager = templateManager;
	}

	protected renderContent(containerEl: HTMLElement): void {
		const { template } = this.plugin.settings;

		const specs: SettingSpec[] = [
			{
				key: "useCustomTemplate",
				type: "toggle",
				name: "Use custom template",
				desc: "Override default formatting for highlight notes.",
				get: () => template.useCustomTemplate,
				set: async (value: boolean) => {
					template.useCustomTemplate = value;
					if (value) {
						const folder = normalizePath(template.templateDir);
						const customs = this.app.vault
							.getFiles()
							.filter((f) => f.path.startsWith(`${folder}/`));
						template.selectedTemplate = customs[0]?.path ?? "";
					} else {
						template.selectedTemplate = "default";
					}
				},
			},
			// Custom path + dropdown when custom is enabled
			{
				key: "templateDir",
				type: "folder",
				name: "Template folder",
				desc: "Vault folder where your custom templates are stored.",
				placeholder: `Default: ${DEFAULT_TEMPLATES_FOLDER}`,
				get: () => template.templateDir,
				set: (value: string) => {
					template.templateDir = value;
				},
				if: () => template.useCustomTemplate,
			},
			{
				key: "selectCustomTemplate",
				type: "dropdown",
				name: "Select custom template",
				desc: (() => {
					const folder = normalizePath(template.templateDir);
					const any = this.app.vault
						.getFiles()
						.some((f) => f.path.startsWith(`${folder}/`));
					return any
						? `Choose a template file from "${folder}".`
						: `No custom templates found in "${folder}".`;
				})(),
				options: () => {
					const folder = normalizePath(template.templateDir);
					const lower = folder.toLowerCase();
					const files = this.app.vault
						.getFiles()
						.filter(
							(f) =>
								f.path.toLowerCase().startsWith(`${lower}/`) &&
								["md", "txt"].includes(f.extension),
						);
					const map: Record<string, string> = {};
					for (const f of files) {
						const name = f.path.slice(folder.length + 1).replace(/\.md$/, "");
						map[f.path] = name;
					}
					return map;
				},
				get: () => template.selectedTemplate,
				set: async (val: string) => {
					template.selectedTemplate = val;
					await this.plugin.saveSettings();
				},
				if: () => template.useCustomTemplate,
				afterRender: (s: Setting) => {
					s.settingEl.addClass("koreader-template-selector");
					s.addButton((btn) =>
						btn
							.setButtonText("Preview")
							.setDisabled(!template.selectedTemplate)
							.onClick(() =>
								this.showPreviewModal(template.selectedTemplate, true),
							),
					);
				},
			},
			// Built-in dropdown and actions when custom is disabled
			{
				key: "selectBuiltInTemplate",
				type: "dropdown",
				name: "Select built-in template",
				desc: "Choose a built-in style for your notes.",
				options: () => {
					const map: Record<string, string> = {};
					for (const t of this.templateManager.builtInTemplates.values()) {
						map[t.id] = `${t.name} - ${t.description}`;
					}
					return map;
				},
				get: () => template.selectedTemplate,
				set: async (val: string) => {
					template.selectedTemplate = val;
					await this.plugin.saveSettings();
				},
				if: () => !template.useCustomTemplate,
				afterRender: (s: Setting) => {
					s.settingEl.addClass("koreader-template-selector");
					s.addButton((btn) =>
						btn
							.setButtonText("Preview")
							.onClick(() =>
								this.showPreviewModal(template.selectedTemplate, false),
							),
					);
					s.addButton((btn) =>
						btn
							.setButtonText("Create from Built-in...")
							.onClick(async () => this.handleCreateFromBuiltIn()),
					);
				},
			},
		];

		renderSettingsSection(containerEl, specs, {
			app: this.app,
			parent: this,
			onSave: async () => this.plugin.saveSettings(true), // re-render on folder change/toggle
		});
	}

	private async showPreviewModal(templateId: string, isCustom: boolean) {
		const templateManager = this.templateManager;

		let definition: Omit<TemplateDefinition, "id">;

		if (isCustom) {
			const content = await templateManager.loadTemplateFromVault(templateId);
			if (!content) {
				new Notice(`Could not load custom template: ${templateId}`);
				return;
			}
			definition = {
				name: templateId.split("/").pop()?.replace(/\.md$/, "") || templateId,
				description: "A custom template from your vault.",
				content: content,
			};
		} else {
			const builtIn = templateManager.builtInTemplates.get(templateId);
			if (!builtIn) {
				new Notice(`Could not find built-in template: ${templateId}`);
				return;
			}
			definition = builtIn;
		}

		new TemplatePreviewModal(this.app, templateManager, definition).open();
	}

	private async handleCreateFromBuiltIn(): Promise<void> {
		const selectedBuiltInId =
			this.plugin.settings.template.selectedTemplate || "default";
		const builtInTemplate =
			this.templateManager.builtInTemplates.get(selectedBuiltInId);

		if (!builtInTemplate) {
			new Notice(
				`Error: Could not find built-in template '${selectedBuiltInId}'.`,
			);
			return;
		}

		const modal = new PromptModal(
			this.app,
			"Create New Template",
			"Enter a name for the new template file...",
			`${builtInTemplate.name} Custom`,
		);
		const newTemplateName = await modal.openAndGetValue();

		if (!newTemplateName || !newTemplateName.trim()) {
			new Notice("Template creation cancelled.");
			return;
		}

		const sanitizedName = newTemplateName.replace(/[\\/:*?"<>|]+/g, "").trim();
		const finalFileName = sanitizedName.endsWith(".md")
			? sanitizedName
			: `${sanitizedName}.md`;

		const templateDir = normalizePath(
			this.plugin.settings.template.templateDir,
		);
		const newTemplatePath = normalizePath(`${templateDir}/${finalFileName}`);

		if (await this.app.vault.adapter.exists(newTemplatePath)) {
			new Notice(
				`Error: A template named "${finalFileName}" already exists in ${templateDir}.`,
			);
			return;
		}

		const contentToCopy = `---\ndescription: 'Custom template based on: ${builtInTemplate.name} - ${builtInTemplate.description}'\n---\n\n${builtInTemplate.content}`;

		try {
			await this.app.vault.create(newTemplatePath, contentToCopy);
			new Notice(`Template created: ${newTemplatePath}`);

			this.plugin.settings.template.useCustomTemplate = true;
			this.plugin.settings.template.selectedTemplate = newTemplatePath;
			await this.plugin.saveSettings(true);
		} catch (error) {
			new Notice(
				"Error creating template file. Check the console for details.",
			);
			console.error(
				"KOReader Importer: TemplateSettingsSection: Failed to create custom template:",
				error,
			);
		}
	}
}
