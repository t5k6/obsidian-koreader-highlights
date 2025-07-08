import { normalize } from "node:path"; // for paths outside of the vault
import { debounce, normalizePath, Notice, Setting } from "obsidian";
import { FolderSuggest } from "src/ui/FolderSuggest";
import { ensureFolderExists } from "src/utils/fileUtils";
import { SettingsSection } from "../SettingsSection";
import { pickDirectory } from "../utils";

const DEFAULT_HIGHLIGHTS_FOLDER = "KOReader Highlights";

export class CoreSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("KOReader mount point")
			.setDesc("Directory where your e-reader is mounted.")
			.addText((txt) => {
				txt
					.setPlaceholder("/path/to/koreader/mount")
					.setValue(this.plugin.settings.koreaderMountPoint);

				txt.inputEl.addEventListener("change", async () => {
					const path = normalize(txt.getValue().trim());
					this.plugin.settings.koreaderMountPoint = path;
					await this.plugin.saveSettings();
				});
			})
			.addButton((btn) =>
				btn.setButtonText("Browse…").onClick(async () => {
					const picked = await pickDirectory();
					if (!picked) return;

					this.plugin.settings.koreaderMountPoint = normalize(picked);
					await this.plugin.saveSettings();
					this.plugin.settingTab.display(); // Re-render to show new value
					new Notice(
						`Mount point set to: ${this.plugin.settings.koreaderMountPoint}`,
					);
				}),
			);

		new Setting(containerEl)
			.setName("Highlights folder")
			.setDesc("Vault folder to save highlight notes.")
			.addText((txt) => {
				const savePath = (path: string) => {
					const p = normalizePath(path.trim() || DEFAULT_HIGHLIGHTS_FOLDER);
					this.plugin.settings.highlightsFolder = p;
					txt.setValue(p);
					this.debouncedSave();
				};

				txt
					.setPlaceholder(DEFAULT_HIGHLIGHTS_FOLDER)
					.setValue(this.plugin.settings.highlightsFolder)
					.onChange(savePath);

				const suggester = new FolderSuggest(this.app, txt.inputEl, savePath);
				const refresh = () => suggester.refreshCache();
				this.plugin.registerEvent(this.app.vault.on("create", refresh));
				this.plugin.registerEvent(this.app.vault.on("delete", refresh));
				this.plugin.registerEvent(this.app.vault.on("rename", refresh));

				txt.inputEl.addEventListener(
					"blur",
					debounce(async () => {
						const created = await ensureFolderExists(
							this.app.vault,
							this.plugin.settings.highlightsFolder,
						);
						if (created) {
							new Notice(
								`Highlights folder created: ${this.plugin.settings.highlightsFolder}`,
							);
						}
					}, 750),
				);
			});
	}
}
