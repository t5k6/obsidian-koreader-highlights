import { DEFAULT_HIGHLIGHTS_FOLDER } from "src/constants";
import { externalFolderSetting, folderSetting } from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class CoreSettingsSection extends SettingsSection {
	protected renderContent(container: HTMLElement): void {
		externalFolderSetting(
			container,
			"KOReader mount point",
			"Directory where your e-reader is mounted.",
			"Example: /mnt/KOReader",
			() => this.plugin.settings.koreaderMountPoint,
			(value) => {
				this.plugin.settings.koreaderMountPoint = value;
				this.debouncedSave();
			},
		);

		folderSetting(
			container,
			this,
			"Highlights folder",
			"Vault folder to save highlight notes.",
			"Default: " + DEFAULT_HIGHLIGHTS_FOLDER,
			this.app,
			() => this.plugin.settings.highlightsFolder,
			(value) => {
				this.plugin.settings.highlightsFolder = value;
				this.debouncedSave();
			},
		);
	}
}
