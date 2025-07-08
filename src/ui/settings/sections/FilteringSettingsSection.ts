import { stringArraySetting } from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class FilteringSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		const [, excludedFoldersComponent] = stringArraySetting(
			containerEl,
			"Excluded folders",
			"Comma-separated list of folder names to ignore during scans.",
			() => this.plugin.settings.excludedFolders,
			(value) => {
				this.plugin.settings.excludedFolders = value;
				this.debouncedSave();
			},
		);
		excludedFoldersComponent.setPlaceholder(".git, .stfolder");

		const [, allowedTypesComponent] = stringArraySetting(
			containerEl,
			"Allowed file types",
			"Process highlights for these book types only (empty = all).",
			() => this.plugin.settings.allowedFileTypes,
			(value) => {
				this.plugin.settings.allowedFileTypes = value.map((v) =>
					v.toLowerCase(),
				);
				this.debouncedSave();
			},
		);
		allowedTypesComponent.setPlaceholder("epub, pdf, mobi");
	}
}
