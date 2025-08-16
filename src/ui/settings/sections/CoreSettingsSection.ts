import { DEFAULT_HIGHLIGHTS_FOLDER } from "src/constants";
import { renderSettingsSection } from "../SettingsKit";
import { SettingsSection } from "../SettingsSection";

export class CoreSettingsSection extends SettingsSection {
	protected renderContent(container: HTMLElement): void {
		renderSettingsSection(
			container,
			[
				{
					key: "scanPath",
					type: "external-folder",
					name: "KOReader scan path",
					desc: "Root folder to scan for KOReader .sdr directories (usually your device mount).",
					placeholder: "Example: /mnt/KOReader",
					get: () => this.plugin.settings.koreaderScanPath,
					set: (v) => {
						this.plugin.settings.koreaderScanPath = v;
					},
				},
				{
					key: "highlightsFolder",
					type: "folder",
					name: "Highlights folder",
					desc: "Vault folder to save highlight notes.",
					placeholder: `Default: ${DEFAULT_HIGHLIGHTS_FOLDER}`,
					get: () => this.plugin.settings.highlightsFolder,
					set: (v) => {
						this.plugin.settings.highlightsFolder = v;
					},
				},
				{
					key: "scanTimeoutSeconds",
					type: "number",
					name: "Duplicate scan timeout (seconds)",
					desc: "Applies when the local index is not persistent. Longer time scans more files but may slow the import.",
					min: 1,
					step: 1,
					get: () => this.plugin.settings.scanTimeoutSeconds ?? 8,
					set: (v) => {
						this.plugin.settings.scanTimeoutSeconds = v;
					},
				},
			],
			{ app: this.app, parent: this, onSave: this.debouncedSave },
		);
	}
}
