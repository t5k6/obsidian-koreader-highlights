import { Notice, type Setting, type TFile } from "obsidian";
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
import { renderSettingsSection, type SettingSpec } from "../SettingsKit";
import { SettingsSection } from "../SettingsSection";

// Helper type guard for the error object
function errorHasPath(err: unknown): err is { path: string } {
	return typeof err === "object" && err !== null && "path" in err;
}

export class TemplateSettingsSection extends SettingsSection {
	private readonly templateManager: TemplateManager;
	private templateFilesCache: { path: string; name: string }[] | null = null;

	constructor(
		plugin: KoreaderImporterPlugin,
		debouncedSave: DebouncedFn,
		title: string,
		templateManager: TemplateManager,
		startOpen = false,
	) {
		super(plugin, debouncedSave, title, startOpen);
		this.templateManager = templateManager;
	}

	protected renderContent(containerEl: HTMLElement): void {
		// Invalidate cache on each render to ensure it's fresh.
		this.templateFilesCache = null;

		const events = [
			this.app.vault.on("create", (file) => this.invalidateOnMatch(file.path)),
			this.app.vault.on("delete", (file) => this.invalidateOnMatch(file.path)),
			this.app.vault.on("rename", (_, oldPath) =>
				this.invalidateOnMatch(oldPath),
			),
		];

		for (const ref of events) {
			this.plugin.registerEvent(ref);
		}

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
						this.ensureTemplateCache(); // Populate cache to find first template
						template.selectedTemplate =
							this.templateFilesCache?.[0]?.path ?? "";
					} else {
						template.selectedTemplate = "default";
					}
				},
			},
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
				desc: () => {
					this.ensureTemplateCache();
					const folder = Pathing.toVaultPath(template.templateDir);
					return this.templateFilesCache && this.templateFilesCache.length > 0
						? `Choose a template file from "${folder}".`
						: `No custom templates found in "${folder}".`;
				},
				options: () => {
					this.ensureTemplateCache();
					return Object.fromEntries(
						(this.templateFilesCache ?? []).map((f) => [f.path, f.name]),
					);
				},
				get: () => template.selectedTemplate,
				set: async (val: string) => {
					template.selectedTemplate = val;
				},
				if: () => template.useCustomTemplate,
				afterRender: (s: Setting) => {
					s.settingEl.addClass("koreader-template-selector");
					s.addButton((btn) =>
						btn
							.setButtonText("Preview")
							.setDisabled(!template.selectedTemplate)
							.onClick(() =>
								runAsyncAction(
									btn,
									() => this.showPreviewModal(template.selectedTemplate, true),
									{ inProgress: "Opening preview..." },
								),
							),
					);
				},
			},
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
				},
				if: () => !template.useCustomTemplate,
				afterRender: (s: Setting) => {
					s.settingEl.addClass("koreader-template-selector");
					s.addButton((btn) =>
						btn
							.setButtonText("Preview")
							.onClick(() =>
								runAsyncAction(
									btn,
									() => this.showPreviewModal(template.selectedTemplate, false),
									{ inProgress: "Opening preview..." },
								),
							),
					);
					s.addButton((btn) =>
						btn.setButtonText("Create from Built-in...").onClick(() =>
							runAsyncAction(btn, () => this.handleCreateFromBuiltIn(), {
								inProgress: "Creating...",
							}),
						),
					);
				},
			},
		];

		renderSettingsSection(containerEl, specs, {
			app: this.app,
			parent: this,
			onSave: async () => this.plugin.saveSettings(true),
		});
	}

	private invalidateOnMatch(changedPath: string): void {
		const folder = Pathing.toVaultPath(
			this.plugin.settings.template.templateDir,
		);
		if (changedPath.startsWith(folder)) {
			this.templateFilesCache = null;
			// A re-render is needed to update the dropdown
			this.plugin.settingTab.display();
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
		// The type signature for definition already allows for the optional path property.
		let definition: Omit<TemplateDefinition, "id"> & { path?: string };

		if (isCustom) {
			const res = await templateManager.loadTemplateResult();
			if (isErr(res)) {
				const path = errorHasPath(res.error)
					? String(res.error.path)
					: templateId;
				new Notice(`Could not load custom template: ${path}`);
				return;
			}

			definition = {
				name: templateId.split("/").pop()?.replace(/\.md$/, "") || templateId,
				description: "A custom template from your vault.",
				content: res.value,
				path: templateId,
			};
		} else {
			const builtIn = templateManager.builtInTemplates.get(templateId);
			if (!builtIn) {
				new Notice(`Could not find built-in template: ${templateId}`);
				return;
			}
			definition = builtIn; // Built-in templates correctly have no path.
		}

		// This call is now correct because `definition` contains the path.
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

		let newTemplateName: string | null;
		try {
			newTemplateName = await InteractionModal.prompt(this.app, {
				title: "Create New Template",
				placeholder: "Enter a name for the new template file...",
				defaultValue: `${builtInTemplate.name} Custom`,
			});
		} catch (e) {
			newTemplateName = null;
		}

		if (!newTemplateName || !newTemplateName.trim()) {
			new Notice("Template creation cancelled.");
			return;
		}

		const sanitizedName = newTemplateName.replace(/[\\/:*?"<>|]+/g, "").trim();
		const finalFileName = sanitizedName.endsWith(".md")
			? sanitizedName
			: `${sanitizedName}.md`;

		const templateDir = Pathing.toVaultPath(
			this.plugin.settings.template.templateDir,
		);
		const newTemplatePath = Pathing.joinVaultPath(templateDir, finalFileName);

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
