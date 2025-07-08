import { Setting } from "obsidian";
import { FrontmatterFieldModal } from "src/ui/FrontmatterFieldModal";
import { booleanSetting } from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class FormattingSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
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
				await this.plugin.saveSettings();
			},
		);

		booleanSetting(
			containerEl,
			"Enable full vault duplicate check",
			"Checks the entire vault for duplicates (slower). When off, only the highlights folder is scanned (faster).",
			() => this.plugin.settings.enableFullDuplicateCheck,
			async (value) => {
				this.plugin.settings.enableFullDuplicateCheck = value;
				await this.plugin.saveSettings();
			},
		);

		booleanSetting(
			containerEl,
			"Use 'Unknown Author' placeholder",
			"When an author is not found, use 'Unknown Author' as a placeholder instead of omitting the field.",
			() => this.plugin.settings.frontmatter.useUnknownAuthor,
			async (value) => {
				this.plugin.settings.frontmatter.useUnknownAuthor = value;
				await this.plugin.saveSettings();
			},
		);
	}
}
