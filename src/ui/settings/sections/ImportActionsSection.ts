import { Setting } from "obsidian";
import type KoReaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { runPluginAction } from "src/utils/actionUtils";
import { SettingsSection } from "../SettingsSection";

export class ImportActionsSection extends SettingsSection {
	constructor(
		plugin: KoReaderImporterPlugin,
		debouncedSave: () => void,
		title: string,
		startOpen = false,
	) {
		super(plugin, debouncedSave, title, startOpen);
	}
	protected renderContent(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Scan / Import")
			.setDesc("Scan for highlight files or import them into your vault.")
			.addButton((btn) =>
				btn.setButtonText("Scan Now").onClick(() =>
					runPluginAction(() => this.plugin.triggerScan(), {
						button: btn,
						inProgressText: "Scanning…",
						completedText: "Scan Now",
						failureNotice: "Scan failed",
					}),
				),
			)
			.addButton((btn) =>
				btn
					.setCta()
					.setButtonText("Import Now")
					.onClick(() =>
						runPluginAction(() => this.plugin.triggerImport(), {
							button: btn,
							inProgressText: "Importing…",
							completedText: "Import Now",
							failureNotice: "Import failed",
						}),
					),
			);
	}
}
