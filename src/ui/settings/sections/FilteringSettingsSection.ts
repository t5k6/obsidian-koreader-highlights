import { stringArraySetting } from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class FilteringSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		stringArraySetting(
			containerEl,
			"Excluded folders",
			"Comma-separated list of folder names to ignore during scans.",
			() => this.plugin.settings.excludedFolders,
			(value) => {
				this.plugin.settings.excludedFolders = value;
			},
			".git, .stfolder",
			this.debouncedSave,
		);

		stringArraySetting(
			containerEl,
			"Allowed file types",
			"Process highlights for these book types only (empty = all).",
			() => this.plugin.settings.allowedFileTypes,
			(value) => {
				this.plugin.settings.allowedFileTypes = value.map((v) =>
					v.toLowerCase(),
				);
			},
			"epub, pdf, mobi",
			this.debouncedSave,
		);
	}
}
