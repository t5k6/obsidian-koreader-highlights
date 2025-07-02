import { Setting } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { FrontmatterFieldModal } from "src/ui/FrontmatterFieldModal";
import { SettingsSection } from "../SettingsSection";

class FrontmatterFieldSetting {
	constructor(containerEl: HTMLElement, plugin: KoreaderImporterPlugin) {
		new Setting(containerEl)
			.setName("Frontmatter fields")
			.setDesc("Choose which standard fields to EXCLUDE from frontmatter.")
			.addButton((btn) =>
				btn.setButtonText("Manage Fields").onClick(() =>
					new FrontmatterFieldModal(
						plugin.app,
						plugin.settings.frontmatter,
						(updated) => {
							plugin.settings.frontmatter = updated;
							plugin.saveSettings();
						},
					).open(),
				),
			);
	}
}

export class FormattingSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		new FrontmatterFieldSetting(containerEl, this.plugin);
		new Setting(containerEl)
			.setName("Enable full vault duplicate check")
			.setDesc(
				"Checks the entire vault for duplicates (slower). When off, only the highlights folder is scanned (faster).",
			)
			.addToggle((tgl) =>
				tgl
					.setValue(this.plugin.settings.enableFullDuplicateCheck)
					.onChange(async (v) => {
						this.plugin.settings.enableFullDuplicateCheck = v;
						await this.plugin.saveSettings();
					}),
			);
	}
}
