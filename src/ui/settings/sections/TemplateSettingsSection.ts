import { normalizePath, Notice, Setting } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { TemplateManager } from "src/services/TemplateManager";
import type { TemplateDefinition } from "src/types";
import { FolderSuggest } from "src/ui/FolderSuggest";
import { TemplatePreviewModal } from "src/ui/TemplatePreviewModal";
import { booleanSetting } from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

const DEFAULT_TEMPLATE_DIR = "Koreader/templates";

export class TemplateSettingsSection extends SettingsSection {
	private readonly templateManager: TemplateManager;

	constructor(
		plugin: KoreaderImporterPlugin,
		debouncedSave: () => void,
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
				this.plugin.settings.template.useCustomTemplate = value;
				await this.plugin.saveSettings();
				// Re-render the entire settings tab to show/hide dependent settings
				this.plugin.settingTab.display();
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

		const settingName = isCustom
			? "Select custom template"
			: "Select built-in template";
		const settingDesc = isCustom
			? `Choose a template file from "${folder}".`
			: "Choose a built-in style for your notes.";

		const setting = new Setting(containerEl)
			.setName(settingName)
			.setDesc(settingDesc);

		if (isCustom) {
			this.addTemplateDirSetting(containerEl);
		}

		setting.addDropdown((dd) => {
			const current = template.selectedTemplate ?? "default";

			if (isCustom) {
				const userFiles = this.app.vault
					.getFiles()
					.filter(
						(f) =>
							f.path.startsWith(`${folder}/`) &&
							["md", "txt"].includes(f.extension),
					)
					.map((f) => f.path);

				if (userFiles.length === 0) {
					setting.setDesc(`No custom templates found in "${folder}".`);
				} else {
					userFiles.forEach((p) => {
						const fileName = p.slice(folder.length + 1).replace(/\.md$/, "");
						dd.addOption(p, fileName);
					});
				}
			} else {
				const templateManager = this.templateManager;
				for (const t of templateManager.builtInTemplates.values()) {
					dd.addOption(t.id, `${t.name} - ${t.description}`);
				}
			}

			dd.setValue(current);
			dd.onChange(async (val) => {
				template.selectedTemplate = val;
				await this.plugin.saveSettings();
				this.plugin.settingTab.display();
			});
		});

		setting.addButton((btn) =>
			btn.setButtonText("Preview").onClick(() => {
				const selected =
					this.plugin.settings.template.selectedTemplate || "default";
				this.showPreviewModal(selected, isCustom);
			}),
		);
	}

	private addTemplateDirSetting(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Template directory")
			.setDesc("Folder where your custom templates are stored.")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_TEMPLATE_DIR)
					.setValue(this.plugin.settings.template.templateDir)
					.onChange(async (value) => {
						const newDir = normalizePath(value.trim() || DEFAULT_TEMPLATE_DIR);
						if (this.plugin.settings.template.templateDir === newDir) return;

						this.plugin.settings.template.templateDir = newDir;
						await this.plugin.saveSettings();
						this.plugin.settingTab.display();
					});

				new FolderSuggest(this.app, text.inputEl, (v) => {
					text.setValue(v);
					text.inputEl.dispatchEvent(new Event("change"));
				});
			});
	}
}
