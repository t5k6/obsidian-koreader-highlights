import { Notice, normalizePath, Setting } from "obsidian";
import { DEFAULT_TEMPLATES_FOLDER } from "src/constants";
import type KoreaderImporterPlugin from "src/main";
import type { TemplateManager } from "src/services/parsing/TemplateManager";
import type { TemplateDefinition } from "src/types";
import { PromptModal } from "src/ui/PromptModal";
import { TemplatePreviewModal } from "src/ui/TemplatePreviewModal";
import { booleanSetting, folderSetting } from "../SettingHelpers";
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
		booleanSetting(
			containerEl,
			"Use custom template",
			"Override default formatting for highlight notes.",
			() => this.plugin.settings.template.useCustomTemplate,
			async (value) => {
				const { template } = this.plugin.settings;
				template.useCustomTemplate = value;

				if (value === true) {
					// Switching TO custom. We need to select a valid custom template.
					const folder = normalizePath(template.templateDir);
					const customTemplates = this.app.vault
						.getFiles()
						.filter((f) => f.path.startsWith(`${folder}/`));

					// Set the selection to the first available custom template, or empty if none.
					template.selectedTemplate =
						customTemplates.length > 0 ? customTemplates[0].path : "";
				} else {
					// Switching TO built-in. Reset to a known-good default.
					template.selectedTemplate = "default";
				}

				await this.plugin.saveSettings(true);
			},
		);

		this.addTemplateSelector(containerEl);
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

	private addTemplateSelector(containerEl: HTMLElement): void {
		const { template } = this.plugin.settings;
		const isCustom = template.useCustomTemplate;
		const folder = normalizePath(template.templateDir);
		const lowerCaseFolder = folder.toLowerCase();

		const settingName = isCustom
			? "Select custom template"
			: "Select built-in template";
		const setting = new Setting(containerEl).setName(settingName);

		if (isCustom) {
			setting.setDesc(`Choose a template file from "${folder}".`); // Show user the original case

			folderSetting(
				containerEl,
				this,
				"Template folder",
				"Vault folder where your custom templates are stored.",
				"Default: " + DEFAULT_TEMPLATES_FOLDER,
				this.app,
				() => this.plugin.settings.template.templateDir,
				(value) => {
					this.plugin.settings.template.templateDir = value;
					this.debouncedSave();
				},
			);

			const customTemplates = this.app.vault.getFiles().filter(
				(f) =>
					// Compare both paths in lowercase ---
					f.path.toLowerCase().startsWith(`${lowerCaseFolder}/`) &&
					["md", "txt"].includes(f.extension),
			);

			if (customTemplates.length > 0) {
				setting.addDropdown((dd) => {
					customTemplates.forEach((f) => {
						const fileName = f.path
							.slice(folder.length + 1)
							.replace(/\.md$/, "");
						dd.addOption(f.path, fileName);
					});
					dd.setValue(template.selectedTemplate);
					dd.onChange(async (val) => {
						template.selectedTemplate = val;
						await this.plugin.saveSettings();
					});
				});
			} else {
				setting.setDesc(`No custom templates found in "${folder}".`);
			}

			setting.addButton((btn) =>
				btn
					.setButtonText("Preview")
					.setDisabled(
						customTemplates.length === 0 || !template.selectedTemplate,
					)
					.onClick(() =>
						this.showPreviewModal(template.selectedTemplate, true),
					),
			);
		} else {
			// --- BUILT-IN TEMPLATE LOGIC ---
			setting.setDesc("Choose a built-in style for your notes.");

			// The dropdown for built-in templates should always appear.
			setting.addDropdown((dd) => {
				for (const t of this.templateManager.builtInTemplates.values()) {
					dd.addOption(t.id, `${t.name} - ${t.description}`);
				}
				dd.setValue(template.selectedTemplate);
				dd.onChange(async (val) => {
					template.selectedTemplate = val;
					await this.plugin.saveSettings();
				});
			});

			setting.addButton((btn) =>
				btn
					.setButtonText("Preview")
					.onClick(() =>
						this.showPreviewModal(template.selectedTemplate, false),
					),
			);

			setting.addButton((btn) =>
				btn
					.setButtonText("Create from Built-in...")
					.onClick(async () => this.handleCreateFromBuiltIn()),
			);
		}
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
