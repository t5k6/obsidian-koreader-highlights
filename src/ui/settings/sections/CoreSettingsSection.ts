import { normalize } from "node:path"; // for paths outside of the vault
import { pathSetting } from "src/ui/settings/SettingHelpers";
import { SettingsSection } from "../SettingsSection";

const DEFAULT_HIGHLIGHTS_FOLDER = "KOReader Highlights";

export class CoreSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		pathSetting(
			containerEl,
			this.app,
			this.plugin,
			"KOReader mount point",
			"Directory where your e-reader is mounted.",
			{ placeholder: "/path/to/koreader/mount", isExternal: true },
			() => this.plugin.settings.koreaderMountPoint,
			async (val) => {
				this.plugin.settings.koreaderMountPoint = normalize(val);
				await this.plugin.saveSettings();
				this.plugin.settingTab.display(); // Re-render to show new value
			},
		);

		pathSetting(
			containerEl,
			this.app,
			this.plugin,
			"Highlights folder",
			"Vault folder to save highlight notes.",
			{
				placeholder: DEFAULT_HIGHLIGHTS_FOLDER,
				defaultPath: DEFAULT_HIGHLIGHTS_FOLDER,
				requireFolder: true,
				// isExternal is omitted, so it defaults to false. No button will be rendered.
			},
			() => this.plugin.settings.highlightsFolder,
			async (v) => {
				this.plugin.settings.highlightsFolder = v;
				this.debouncedSave();
			},
		);
	}
}
