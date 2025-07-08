import { Notice, Setting } from "obsidian";
import type { KoreaderHighlightImporterSettings } from "src/types";
import { DebugLevel } from "src/utils/logging";
import { booleanSetting, dropdownSetting } from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class AdvancedSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Clear Caches")
			.setDesc(
				"Force re-scan for files and re-parse of metadata on next import.",
			)
			.addButton((button) =>
				button
					.setButtonText("Clear Now")
					.setWarning()
					.onClick(async () => {
						await this.plugin.clearCaches();
						new Notice("KOReader Importer caches cleared.");
					}),
			);

		booleanSetting(
			containerEl,
			"Enable Debug File Logging",
			"Write debug messages to a file. Can be toggled live.",
			() => this.plugin.settings.debugMode,
			async (value) => {
				this.plugin.settings.debugMode = value;
				await this.plugin.saveSettings();
			},
		);

		dropdownSetting(
			containerEl,
			"Debug level",
			"Controls verbosity of logs. 'Info' is most verbose.",
			{
				[DebugLevel.INFO]: "Info",
				[DebugLevel.WARN]: "Warnings",
				[DebugLevel.ERROR]: "Errors",
				[DebugLevel.NONE]: "None",
			},
			() => String(this.plugin.settings.debugLevel),
			async (value) => {
				const level = Number.parseInt(
					value,
					10,
				) as KoreaderHighlightImporterSettings["debugLevel"];
				this.plugin.settings.debugLevel = level;
				await this.plugin.saveSettings();
			},
		);
	}
}
