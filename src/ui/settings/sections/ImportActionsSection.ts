import { Setting } from "obsidian";
import { runAsyncAction } from "src/ui/utils/actionUtils";
import { SettingsSection } from "../SettingsSection";

export class ImportActionsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Scan / Import")
			.setDesc("Scan for highlight files or import them into your vault.")
			.addButton((btn) => {
				btn.setButtonText("Scan Now").onClick(() =>
					runAsyncAction(btn, () => this.plugin.triggerScan(), {
						inProgress: "Scanning…",
						original: "Scan Now",
					}),
				);
			})
			.addButton((btn) => {
				btn
					.setButtonText("Import Now")
					.setCta()
					.onClick(() =>
						runAsyncAction(btn, () => this.plugin.triggerImport(), {
							inProgress: "Importing…",
							original: "Import Now",
						}),
					);
			});
	}
}
