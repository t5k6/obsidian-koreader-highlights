import { debounce, normalizePath, Notice, Setting } from "obsidian";
import { FolderSuggest } from "src/ui/FolderSuggest";
import { ensureFolderExists } from "src/utils/fileUtils";
import { SettingsSection } from "../SettingsSection";
import { pickDirectory } from "../utils";

const DEFAULT_HIGHLIGHTS_FOLDER = "KOReader Highlights";

export class CoreSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		// ----- mount point ----------------------------------------
		new Setting(containerEl)
			.setName("KOReader mount point")
			.setDesc("Directory where your e-reader is mounted.")
			.addText((txt) =>
				txt
					.setPlaceholder("/path/to/koreader/mount")
					.setValue(this.plugin.settings.koboMountPoint)
					.onChange((v) => {
						this.plugin.settings.koboMountPoint = normalizePath(v.trim());
						this.debouncedSave();
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("Browse…").onClick(async () => {
					const picked = await pickDirectory();
					if (!picked) return;

					const norm = normalizePath(picked);
					this.plugin.settings.koboMountPoint = norm;
					await this.plugin.saveSettings();
					this.plugin.settingTab.display(); // Re-render the whole tab
					new Notice(`Mount point set to: ${norm}`);
				}),
			);

		// ----- highlights folder ----------------------------------
		new Setting(containerEl)
			.setName("Highlights folder")
			.setDesc("Vault folder to save highlight notes.")
			.addText((txt) => {
				const write = (path: string) => {
					const p = normalizePath(path.trim() || DEFAULT_HIGHLIGHTS_FOLDER);
					this.plugin.settings.highlightsFolder = p;
					txt.setValue(p);
					this.debouncedSave();
				};

				txt
					.setPlaceholder(DEFAULT_HIGHLIGHTS_FOLDER)
					.setValue(this.plugin.settings.highlightsFolder)
					.onChange(write);

				const suggest = new FolderSuggest(this.app, txt.inputEl, write);
				this.plugin.registerEvent(
					this.app.vault.on("create", () => suggest.refreshCache()),
				);
				this.plugin.registerEvent(
					this.app.vault.on("delete", () => suggest.refreshCache()),
				);
				this.plugin.registerEvent(
					this.app.vault.on("rename", () => suggest.refreshCache()),
				);

				txt.inputEl.addEventListener("blur", () =>
					debounce(async () => {
						const created = await ensureFolderExists(
							this.app.vault,
							this.plugin.settings.highlightsFolder,
						);
						if (created)
							new Notice(
								`Highlights folder created: ${this.plugin.settings.highlightsFolder}`,
							);
					}, 750)(),
				);
			});
	}
}
