import { Notice, Setting } from "obsidian";
import type { KoreaderHighlightImporterSettings } from "src/types";
import { setDebugLevel } from "src/utils/logging";
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

		new Setting(containerEl)
			.setName("Enable Debug File Logging")
			.setDesc("Write debug messages to a file. Requires plugin reload.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugMode)
					.onChange(async (value) => {
						this.plugin.settings.debugMode = value;
						await this.plugin.saveSettings();
						const notice = new Notice(
							`Debug logging ${value ? "enabled" : "disabled"}. Reload for changes to take effect.`,
							10000,
						);
						const button = document.createElement("button");
						button.textContent = "Reload Now";
						button.onclick = () =>
							(this.app as any).commands.executeCommandById("app:reload");
						notice.noticeEl.appendChild(button);
					}),
			);

		new Setting(containerEl)
			.setName("Debug level")
			.setDesc("Controls verbosity of logs. 'Info' is most verbose.")
			.addDropdown((dropdown) => {
				dropdown.addOption("1", "Info");
				dropdown.addOption("2", "Warnings");
				dropdown.addOption("3", "Errors");
				dropdown.addOption("0", "None");
				dropdown.setValue(String(this.plugin.settings.debugLevel));
				dropdown.onChange(async (value) => {
					const level = Number.parseInt(
						value,
						10,
					) as KoreaderHighlightImporterSettings["debugLevel"];
					this.plugin.settings.debugLevel = level;
					setDebugLevel(level);
					await this.plugin.saveSettings();
				});
			});
	}
}
