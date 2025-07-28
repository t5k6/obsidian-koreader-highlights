import { DEFAULT_HIGHLIGHTS_FOLDER } from "src/constants";
import { SettingsSection } from "../SettingsSection";
import { externalFolderSetting, folderSetting } from "../SettingHelpers";

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
  }
}
