import { FileNameGenerator } from "src/services/vault/FileNameGenerator";
import { FrontmatterFieldModal } from "src/ui/FrontmatterFieldModal";
import { renderSettingsSection } from "../SettingsKit";
import { SettingsSection } from "../SettingsSection";

export class FormattingSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		// Single declarative render with custom/buttons specs
		renderSettingsSection(
			containerEl,
			[
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
					desc: "Available placeholders: {{title}}, {{authors}}, {{importDate}}.",
					if: () => this.plugin.settings.useCustomFileNameTemplate,
					render: (s) => {
						const validator = new FileNameGenerator(this.plugin.loggingService);
						const validationEl = s.descEl.createDiv({
							cls: "setting-item-description koreader-setting-validation",
						});
						const update = (value: string) => {
							const { errors, warnings } = validator.validate(value);
							const errorHtml = errors.map((e) => `<li>${e}</li>`).join("");
							const warningHtml = warnings.map((w) => `<li>${w}</li>`).join("");
							validationEl.innerHTML = `<ul>${errorHtml}${warningHtml}</ul>`;
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
									await this.plugin.saveSettings();
								});
						});
						update(this.plugin.settings.fileNameTemplate);
					},
				},
				{
					key: "frontmatterModal",
					type: "buttons",
					name: "Frontmatter fields",
					desc: "Choose which standard fields to EXCLUDE from frontmatter.",
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
					key: "autoMergeOnAddition",
					type: "toggle",
					name: "Auto-merge on addition",
					desc: "Automatically merge imports if they only add new highlights, without showing the duplicate dialog.",
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
				{
					key: "useUnknownAuthor",
					type: "toggle",
					name: "Use 'Unknown Author' placeholder",
					desc: "When an author is not found, use 'Unknown Author' as a placeholder instead of omitting the field.",
					get: () => this.plugin.settings.frontmatter.useUnknownAuthor,
					set: async (value) => {
						this.plugin.settings.frontmatter.useUnknownAuthor = value;
					},
				},
			],
			{
				app: this.app,
				parent: this,
				onSave: async () => this.plugin.saveSettings(true),
			},
		);
	}
}
