import { Notice, Setting, type TFile } from "obsidian";
import { DEFAULT_TEMPLATES_FOLDER } from "src/constants";
import { isErr } from "src/lib/core/result";
import { isTFile } from "src/lib/obsidian/typeguards";
import { Pathing } from "src/lib/pathing";
import type KoreaderImporterPlugin from "src/main";
import type { TemplateManager } from "src/services/parsing/TemplateManager";
import type { DebouncedFn, TemplateDefinition } from "src/types";
import { InteractionModal } from "src/ui/InteractionModal";
import { TemplatePreviewModal } from "src/ui/TemplatePreviewModal";
import { runAsyncAction } from "src/ui/utils/actionUtils";
import { SettingsSection } from "../SettingsSection";

export class TemplateSettingsSection extends SettingsSection {
	private templateFilesCache: { path: string; name: string }[] | null = null;

	constructor(
		plugin: KoreaderImporterPlugin,
		debouncedSave: DebouncedFn,
		title: string,
		private templateManager: TemplateManager,
		startOpen = false,
	) {
		super(plugin, debouncedSave, title, startOpen);
	}

	override onload(): void {
		// Register vault event listeners once in the component lifecycle
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.invalidateOnMatch(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.invalidateOnMatch(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (_, oldPath) => {
				this.invalidateOnMatch(oldPath);
			}),
		);
	}

	protected renderContent(containerEl: HTMLElement): void {
		// Invalidate cache on render
		this.templateFilesCache = null;

		const { template } = this.plugin.settings;

		new Setting(containerEl)
			.setName("Use custom template")
			.setDesc("Override default formatting for highlight notes.")
			.addToggle((toggle) => {
				toggle.setValue(template.useCustomTemplate).onChange(async (value) => {
					template.useCustomTemplate = value;
					if (value) {
						this.ensureTemplateCache();
						template.selectedTemplate =
							this.templateFilesCache?.[0]?.path ?? "";
					} else {
						template.selectedTemplate = "default";
					}
					// Important: Reload to show/hide subsequent fields
					await this.saveAndReload();
				});
			});

		if (template.useCustomTemplate) {
			new Setting(containerEl)
				.setName("Template folder")
				.setDesc("Vault folder where your custom templates are stored.")
				.addSearch((search) => {
					search
						.setPlaceholder(`Default: ${DEFAULT_TEMPLATES_FOLDER}`)
						.setValue(template.templateDir);

					// Dynamic import to avoid circular dependencies
					import("../suggesters/FolderSuggester").then(({ FolderSuggest }) => {
						new FolderSuggest(this.app, search.inputEl);
					});

					search.inputEl.addEventListener("blur", async () => {
						const normalized = Pathing.toVaultPath(search.getValue());
						template.templateDir = normalized;
						// Reload to update the dropdown cache based on new folder
						await this.saveAndReload();
					});
				});

			// Ensure cache is ready for dropdown
			this.ensureTemplateCache();
			const folder = Pathing.toVaultPath(template.templateDir);
			const templates: { path: string; name: string }[] =
				this.templateFilesCache || [];
			const desc =
				templates.length > 0
					? `Choose a template file from "${folder}".`
					: `No custom templates found in "${folder}".`;

			const dropdownSetting = new Setting(containerEl)
				.setName("Select custom template")
				.setDesc(desc)
				.addDropdown((dd) => {
					for (const t of templates) {
						dd.addOption(t.path, t.name);
					}
					dd.setValue(template.selectedTemplate);
					dd.onChange(async (v) => {
						template.selectedTemplate = v;
						this.debouncedSave();
						// Update button state
						previewBtn.setDisabled(!v);
					});
				});

			dropdownSetting.settingEl.addClass("koreader-template-selector");

			let previewBtn: any; // Will capture button reference
			dropdownSetting.addButton((btn) => {
				previewBtn = btn; // Capture reference safely
				btn
					.setButtonText("Preview")
					.setDisabled(!template.selectedTemplate)
					.onClick(() =>
						runAsyncAction(
							btn,
							() => this.showPreviewModal(template.selectedTemplate, true),
							{ inProgress: "Opening..." },
						),
					);
			});
		} else {
			// Built-in templates
			const dropdownSetting = new Setting(containerEl)
				.setName("Select built-in template")
				.setDesc("Choose a built-in style for your notes.")
				.addDropdown((dd) => {
					for (const t of this.templateManager.builtInTemplates.values()) {
						dd.addOption(t.id, `${t.name} - ${t.description}`);
					}
					dd.setValue(template.selectedTemplate).onChange(async (v) => {
						template.selectedTemplate = v;
						this.debouncedSave();
					});
				});

			dropdownSetting.settingEl.addClass("koreader-template-selector");
			dropdownSetting
				.addButton((btn) =>
					btn
						.setButtonText("Preview")
						.onClick(() =>
							runAsyncAction(
								btn,
								() => this.showPreviewModal(template.selectedTemplate, false),
								{ inProgress: "Opening..." },
							),
						),
				)
				.addButton((btn) =>
					btn.setButtonText("Create from Built-in...").onClick(() =>
						runAsyncAction(btn, () => this.handleCreateFromBuiltIn(), {
							inProgress: "Creating...",
						}),
					),
				);
		}
	}

	private ensureTemplateCache(): void {
		if (this.templateFilesCache !== null) return;
		const folder = Pathing.toVaultPath(
			this.plugin.settings.template.templateDir,
		);
		const lowerFolder = folder.toLowerCase();
		this.templateFilesCache = this.app.vault
			.getFiles()
			.filter(
				(f): f is TFile =>
					isTFile(f) &&
					f.path.toLowerCase().startsWith(`${lowerFolder}/`) &&
					["md", "txt"].includes(f.extension),
			)
			.map((f) => ({
				path: f.path,
				name: f.path.slice(folder.length + 1).replace(/\.md$/, ""),
			}));
	}

	private async showPreviewModal(templateId: string, isCustom: boolean) {
		const templateManager = this.templateManager;
		let definition: Omit<TemplateDefinition, "id"> & { path?: string };

		if (isCustom) {
			const res = await templateManager.loadTemplateResult();
			if (isErr(res)) {
				new Notice(`Could not load custom template: ${templateId}`);
				return;
			}
			definition = {
				name: templateId.split("/").pop()?.replace(/\.md$/, "") || templateId,
				description: "A custom template from your vault.",
				content: res.value,
				path: templateId,
			};
		} else {
			const id = templateId || "default";
			const builtIn = templateManager.builtInTemplates.get(id);
			if (!builtIn) {
				new Notice(`Could not find built-in template: ${templateId}`);
				return;
			}
			definition = builtIn;
		}
		new TemplatePreviewModal(this.app, templateManager, definition).open();
	}

	private invalidateOnMatch(changedPath: string): void {
		const folder = Pathing.toVaultPath(
			this.plugin.settings.template.templateDir,
		);
		if (changedPath.startsWith(folder)) {
			this.templateFilesCache = null;
			// Trigger a re-render to update the dropdown
			this.plugin.settingTab.display();
		}
	}

	private async handleCreateFromBuiltIn(): Promise<void> {
		const selectedBuiltInId =
			this.plugin.settings.template.selectedTemplate || "default";
		const builtInTemplate =
			this.templateManager.builtInTemplates.get(selectedBuiltInId);
		if (!builtInTemplate) return;

		let newTemplateName: string | null;
		try {
			newTemplateName = await InteractionModal.prompt(this.app, {
				title: "Create New Template",
				placeholder: "Enter name...",
				defaultValue: `${builtInTemplate.name} Custom`,
			});
		} catch {
			new Notice("Template creation cancelled.");
			return;
		}

		if (!newTemplateName?.trim()) return;

		const sanitizedName = newTemplateName.replace(/[\\/:*?"<>|]+/g, "").trim();
		const finalFileName = sanitizedName.endsWith(".md")
			? sanitizedName
			: `${sanitizedName}.md`;
		const templateDir = Pathing.toVaultPath(
			this.plugin.settings.template.templateDir,
		);
		const newTemplatePath = Pathing.joinVaultPath(templateDir, finalFileName);

		// Check if file already exists before attempting creation
		const existsResult =
			await this.templateManager.fs.vaultExists(newTemplatePath);
		if (isErr(existsResult)) {
			new Notice("Error checking if template exists. See console for details.");
			console.error("Failed to check template existence:", existsResult.error);
			return;
		}

		if (existsResult.value) {
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
		} catch (e) {
			console.error(e);
			new Notice(
				"Error creating template file. Check the console for details.",
			);
		}
	}
}
