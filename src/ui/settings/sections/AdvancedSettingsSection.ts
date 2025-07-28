import { Notice, Setting } from "obsidian";
import type { KoreaderHighlightImporterSettings } from "src/types";
import { LogLevel } from "src/utils/logging";
import {
  booleanSetting,
  dropdownSetting,
  folderSetting,
} from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";
import { DEFAULT_LOGS_FOLDER } from "src/constants";

export class AdvancedSettingsSection extends SettingsSection {
  protected renderContent(containerEl: HTMLElement): void {
    dropdownSetting(
      containerEl,
      "Debug log level",
      "Controls verbosity of logs. 'None' disables logging. 'Info' is most verbose.",
      {
        [LogLevel.NONE]: "None",
        [LogLevel.ERROR]: "Errors",
        [LogLevel.WARN]: "Warnings",
        [LogLevel.INFO]: "Info",
      },
      () => String(this.plugin.settings.logLevel),
      async (value) => {
        const level = Number.parseInt(
          value,
          10,
        ) as KoreaderHighlightImporterSettings["logLevel"];
        this.plugin.settings.logLevel = level;
        await this.plugin.saveSettings();
      },
    );

    booleanSetting(
      containerEl,
      "Log to file",
      "On top of writing to the Developer Tools Console, write debug logs to a file in your vault.",
      () => this.plugin.settings.logToFile,
      async (value) => {
        this.plugin.settings.logToFile = value;
        await this.plugin.saveSettings(true);
      },
    );

    if (this.plugin.settings.logToFile) {
      folderSetting(
        containerEl,
        "Log folder",
        "Debug logs will be written to this folder.",
        "Default: " + DEFAULT_LOGS_FOLDER,
        this.app,
        () => this.plugin.settings.logsFolder,
        (value) => {
          this.plugin.settings.logsFolder = value;
          this.debouncedSave();
        },
      );
    }

    new Setting(containerEl)
      .setName("Clear caches")
      .setDesc(
        "Force re-scan for files and re-parse of metadata on next import.",
      )
      .addButton((button) =>
        button
          .setButtonText("Clear caches")
          .setWarning()
          .onClick(async () => {
            await this.plugin.triggerClearCaches();
            new Notice("KOReader Importer caches cleared.");
          }),
      );
  }
}
