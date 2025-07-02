import { Setting } from "obsidian";
import { SettingsSection } from "../SettingsSection";

export class FilteringSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("Comma-separated list of folder names to ignore during scans.")
			.addTextArea((txt) =>
				txt
					.setValue(this.plugin.settings.excludedFolders.join(", "))
					.setPlaceholder(".git, .stfolder, $RECYCLE.BIN")
					.onChange((v) => {
						this.plugin.settings.excludedFolders = v
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						this.debouncedSave();
					}),
			);

		new Setting(containerEl)
			.setName("Allowed file types")
			.setDesc("Process highlights for these book types only (empty = all).")
			.addText((txt) =>
				txt
					.setValue(this.plugin.settings.allowedFileTypes.join(", "))
					.setPlaceholder("epub, pdf, mobi")
					.onChange((v) => {
						this.plugin.settings.allowedFileTypes = v
							.split(",")
							.map((s) => s.trim().toLowerCase())
							.filter(Boolean);
						this.debouncedSave();
					}),
			);
	}
}
