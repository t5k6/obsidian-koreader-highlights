import { renderSettingsSection } from "../SettingsKit";
import { SettingsSection } from "../SettingsSection";

export class FilteringSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		renderSettingsSection(
			containerEl,
			[
				{
					key: "excludedFolders",
					type: "string-list",
					name: "Excluded folders",
					desc: "Comma-separated list of folder names to ignore during scans.",
					placeholder: ".git, .stfolder",
					get: () => this.plugin.settings.excludedFolders,
					set: (value) => {
						this.plugin.settings.excludedFolders = value;
					},
				},
				{
					key: "allowedFileTypes",
					type: "string-list",
					name: "Allowed file types",
					desc: "Process highlights for these book types only (empty = all).",
					placeholder: "epub, pdf, mobi",
					get: () => this.plugin.settings.allowedFileTypes,
					set: (value) => {
						this.plugin.settings.allowedFileTypes = value.map((v) =>
							v.toLowerCase(),
						);
					},
				},
			],
			{ app: this.app, parent: this, onSave: this.debouncedSave },
		);
	}
}
