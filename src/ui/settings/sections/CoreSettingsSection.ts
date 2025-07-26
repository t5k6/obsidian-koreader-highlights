import { pathSetting } from "src/ui/settings/SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class CoreSettingsSection extends SettingsSection {
	protected renderContent(container: HTMLElement): void {
		pathSetting(container, this.app, this.plugin, {
			label: "KOReader mount point",
			desc: "Directory where your e-reader is mounted.",
			get: () => this.plugin.settings.koreaderMountPoint,
			setAndSave: async (v) => {
				this.plugin.settings.koreaderMountPoint = v;
				await this.plugin.saveSettings();
			},
			isExternal: true,
		});

		pathSetting(container, this.app, this.plugin, {
			label: "Highlights folder",
			desc: "Vault folder to save highlight notes.",
			get: () => this.plugin.settings.highlightsFolder,
			setAndSave: async (v) => {
				this.plugin.settings.highlightsFolder = v;
				await this.plugin.saveSettings();
			},
			requireFolder: true,
		});
	}
}
