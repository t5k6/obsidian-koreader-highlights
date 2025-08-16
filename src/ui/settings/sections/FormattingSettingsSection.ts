import { Setting } from "obsidian";
import { FileNameGenerator } from "src/services/vault/FileNameGenerator";
import { FrontmatterFieldModal } from "src/ui/FrontmatterFieldModal";
import { booleanSetting, createSetting } from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class FormattingSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		booleanSetting(
			containerEl,
			"Use custom file name template",
			"Define a custom naming scheme for imported highlight notes.",
			() => this.plugin.settings.useCustomFileNameTemplate,
			async (value) => {
				this.plugin.settings.useCustomFileNameTemplate = value;
			},
			async () => this.plugin.saveSettings(true), // Force re-render
		);

		if (this.plugin.settings.useCustomFileNameTemplate) {
			const setting = createSetting(
				containerEl,
				"File name template",
				"Available placeholders: {{title}}, {{authors}}, {{importDate}}.",
			);

			const validator = new FileNameGenerator(this.plugin.loggingService);
			const validationEl = setting.descEl.createDiv({
				cls: "setting-item-description koreader-setting-validation",
			});

			const updateValidation = (value: string) => {
				const { errors, warnings } = validator.validate(value);
				const errorHtml = errors.map((e) => `<li>${e}</li>`).join("");
				const warningHtml = warnings.map((w) => `<li>${w}</li>`).join("");
				validationEl.innerHTML = `<ul>${errorHtml}${warningHtml}</ul>`;
				validationEl.style.color =
					errors.length > 0 ? "var(--text-error)" : "var(--text-muted)";
			};

			setting.addText((text) => {
				text
					.setPlaceholder("{{title}} - {{authors}}")
					.setValue(this.plugin.settings.fileNameTemplate)
					.onChange(async (value) => {
						this.plugin.settings.fileNameTemplate = value;
						updateValidation(value);
						await this.plugin.saveSettings();
					});
			});

			updateValidation(this.plugin.settings.fileNameTemplate);
		}

		new Setting(containerEl)
			.setName("Frontmatter fields")
			.setDesc("Choose which standard fields to EXCLUDE from frontmatter.")
			.addButton((btn) =>
				btn.setButtonText("Manage Fields").onClick(() =>
					new FrontmatterFieldModal(
						this.app,
						this.plugin.settings.frontmatter,
						(updated) => {
							this.plugin.settings.frontmatter = updated;
							this.plugin.saveSettings();
						},
					).open(),
				),
			);

		booleanSetting(
			containerEl,
			"Auto-merge on addition",
			"Automatically merge imports if they only add new highlights, without showing the duplicate dialog.",
			() => this.plugin.settings.autoMergeOnAddition,
			async (value) => {
				this.plugin.settings.autoMergeOnAddition = value;
			},
			this.debouncedSave,
		);

		booleanSetting(
			containerEl,
			"Enable full vault duplicate check",
			"Checks the entire vault for duplicates (slower). When off, only the highlights folder is scanned (faster).",
			() => this.plugin.settings.enableFullDuplicateCheck,
			async (value) => {
				this.plugin.settings.enableFullDuplicateCheck = value;
			},
			this.debouncedSave,
		);

		booleanSetting(
			containerEl,
			"Use 'Unknown Author' placeholder",
			"When an author is not found, use 'Unknown Author' as a placeholder instead of omitting the field.",
			() => this.plugin.settings.frontmatter.useUnknownAuthor,
			async (value) => {
				this.plugin.settings.frontmatter.useUnknownAuthor = value;
			},
			this.debouncedSave,
		);
	}
}
