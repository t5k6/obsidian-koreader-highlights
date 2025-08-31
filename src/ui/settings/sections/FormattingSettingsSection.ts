import { validateFileNameTemplate } from "src/lib/pathing";
import { FrontmatterFieldModal } from "src/ui/FrontmatterFieldModal";
import { renderValidationError } from "src/ui/utils/modalComponents";
import { renderSettingsSection, type SettingSpec } from "../SettingsKit";
import { SettingsSection } from "../SettingsSection";

export class FormattingSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		const specs: SettingSpec[] = [
			// --- Filtering Settings (from FilteringSettingsSection) ---
			{
				key: "excludedFolders",
				type: "string-list",
				name: "Excluded folders",
				desc: "Comma-separated list of folder names to ignore during scans.",
				placeholder: ".git, .stfolder",
				get: () => this.plugin.settings.excludedFolders,
				set: (value) => {
					this.plugin.settings.excludedFolders = value;
				},
			},
			{
				key: "allowedFileTypes",
				type: "string-list",
				name: "Allowed file types",
				desc: "Process highlights for these book types only.",
				placeholder: "epub, pdf, mobi",
				get: () => this.plugin.settings.allowedFileTypes,
				set: (value) => {
					this.plugin.settings.allowedFileTypes = value.map((v) =>
						v.toLowerCase(),
					);
				},
			},

			// --- Formatting Settings (Original) ---
			{ type: "header", text: "Note Formatting", level: 4 },
			{
				key: "useCustomFileNameTemplate",
				type: "toggle",
				name: "Use custom file name template",
				desc: "Define a custom naming scheme for imported highlight notes.",
				get: () => this.plugin.settings.useCustomFileNameTemplate,
				set: async (value) => {
					this.plugin.settings.useCustomFileNameTemplate = value;
				},
			},
			{
				key: "fileNameTemplate",
				type: "custom",
				name: "File name template",
				desc: "Placeholders: {{title}}, {{authors}}, {{importDate}}.",
				if: () => this.plugin.settings.useCustomFileNameTemplate,
				render: (s) => {
					const validationEl = s.descEl.createDiv({
						cls: "setting-item-description koreader-setting-validation",
					});

					const update = (value: string) => {
						const { errors, warnings } = validateFileNameTemplate(value);
						const allMessages = [...errors, ...warnings];
						renderValidationError(validationEl, allMessages);
						validationEl.style.color =
							errors.length > 0 ? "var(--text-error)" : "var(--text-muted)";
					};

					s.addText((text) => {
						text
							.setPlaceholder("{{title}} - {{authors}}")
							.setValue(this.plugin.settings.fileNameTemplate)
							.onChange(async (value) => {
								this.plugin.settings.fileNameTemplate = value;
								update(value);
								this.debouncedSave();
							});
					});
					update(this.plugin.settings.fileNameTemplate); // Initial validation
				},
			},
			{
				key: "frontmatterModal",
				type: "buttons",
				name: "Frontmatter fields",
				desc: "Choose which fields to include or exclude from frontmatter.",
				buttons: [
					{
						text: "Manage Fields",
						onClick: async () => {
							const result = await new FrontmatterFieldModal(
								this.app,
								this.plugin.settings.frontmatter,
							).openAndAwaitResult();
							if (result) {
								this.plugin.settings.frontmatter = result;
								await this.plugin.saveSettings();
							}
						},
					},
				],
			},
			{
				key: "useUnknownAuthor",
				type: "toggle",
				name: "Use 'Unknown Author' placeholder",
				desc: "When an author is not found, use 'Unknown Author' instead of omitting the field.",
				get: () => this.plugin.settings.frontmatter.useUnknownAuthor,
				set: async (value) => {
					this.plugin.settings.frontmatter.useUnknownAuthor = value;
				},
			},

			// --- Duplicate Handling Settings (Original) ---
			{ type: "header", text: "Duplicate Handling", level: 4 },
			{
				key: "autoMergeOnAddition",
				type: "toggle",
				name: "Auto-merge on addition",
				desc: "Automatically merge imports if they only add new highlights, without showing a dialog.",
				get: () => this.plugin.settings.autoMergeOnAddition,
				set: async (value) => {
					this.plugin.settings.autoMergeOnAddition = value;
				},
			},
			{
				key: "enableFullDuplicateCheck",
				type: "toggle",
				name: "Enable full vault duplicate check",
				desc: "Checks the entire vault for duplicates (slower). When off, only the highlights folder is scanned (faster).",
				get: () => this.plugin.settings.enableFullDuplicateCheck,
				set: async (value) => {
					this.plugin.settings.enableFullDuplicateCheck = value;
				},
			},
		];

		renderSettingsSection(containerEl, specs, {
			app: this.app,
			parent: this,
			onSave: async () => this.plugin.saveSettings(true),
		});
	}
}
