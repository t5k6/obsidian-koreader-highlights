import { DEFAULT_HIGHLIGHTS_FOLDER } from "src/constants";
import {
	externalFolderSetting,
	numberSetting,
	SettingBuilder,
} from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class CoreSettingsSection extends SettingsSection {
	protected renderContent(container: HTMLElement): void {
		externalFolderSetting(
			container,
			"KOReader scan path",
			"Root folder to scan for KOReader .sdr directories (usually your device mount).",
			"Example: /mnt/KOReader",
			() => this.plugin.settings.koreaderScanPath,
			(value) => {
				this.plugin.settings.koreaderScanPath = value;
			},
			this.debouncedSave,
		);

		new SettingBuilder(container, this.debouncedSave, this.app, this)
			.name("Highlights folder")
			.desc("Vault folder to save highlight notes.")
			.folder(
				() => this.plugin.settings.highlightsFolder,
				(value) => {
					this.plugin.settings.highlightsFolder = value;
				},
				{ placeholder: "Default: " + DEFAULT_HIGHLIGHTS_FOLDER },
			)
			.build();

		numberSetting(
			container,
			"Duplicate scan timeout (seconds)",
			"Applies when the local index is not persistent. Longer time scans more files but may slow the import.",
			() => this.plugin.settings.scanTimeoutSeconds ?? 8,
			(v) => {
				this.plugin.settings.scanTimeoutSeconds = v;
			},
			{ min: 1, step: 1, onSave: this.debouncedSave },
		);
	}
}
