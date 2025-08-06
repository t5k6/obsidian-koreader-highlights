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

		// Configurable timeout for degraded duplicate scan
		const timeoutSetting = container.createDiv({ cls: "setting-item" });
		const name = timeoutSetting.createDiv({ cls: "setting-item-name" });
		name.setText("Duplicate scan timeout (seconds)");
		const desc = timeoutSetting.createDiv({ cls: "setting-item-description" });
		desc.setText(
			"Applies when the local index is not persistent. Longer time scans more files but may slow the import.",
		);
		const control = timeoutSetting.createDiv({ cls: "setting-item-control" });
		const input = control.createEl("input", {
			type: "number",
			attr: { min: "1", step: "1" },
		});
		input.value = String(this.plugin.settings.scanTimeoutSeconds ?? 8);
		input.addEventListener("change", () => {
			const v = Math.max(1, Number(input.value) || 8);
			this.plugin.settings.scanTimeoutSeconds = v;
			this.debouncedSave();
		});
	}
}
