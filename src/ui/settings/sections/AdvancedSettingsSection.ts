import { Notice, Setting, setIcon } from "obsidian";;
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

    		new Setting(containerEl)
			.setName("Comment Style")
			.setDesc(
				"Choose between HTML or MD style comments for tracking imported highlights.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						html: "HTML Style Comments",
						md: "MD Style Comments",
						none: "None",
					})
					.setValue(this.plugin.settings.commentStyle)
					.onChange(async (value) => {
						this.plugin.settings.commentStyle =
							value as KoreaderHighlightImporterSettings["commentStyle"];
						await this.plugin.saveSettings();

						// Toggle warning visibility
						warningEl.style.display = value === "none" ? "block" : "none";
					});
			});

		// Create comment style setting and warning
		const warningEl = this.createCommentStyleWarning(containerEl);

		new Setting(containerEl)
			.setName("Convert Existing Files")
			.setDesc(
				"Convert all existing highlight files to use the selected comment style. This will rewrite all files in your highlights folder.",
			)
			.addButton((button) =>
				button
					.setButtonText("Convert All Files")
					.setWarning()
					.onClick(async () => {
						await this.plugin.triggerConvertCommentStyle();
					}),
			);
	}

	/**
	 * Creates a warning callout element for the "None" comment style option.
	 * @param containerEl - The container to append the warning after the setting
	 * @returns The warning element for visibility control
	 */
	private createCommentStyleWarning(containerEl: HTMLElement): HTMLElement {
		const warningEl = containerEl.createDiv({
			cls: "callout",
			attr: {
				"data-callout": "warning",
			},
		});

		const calloutTitle = warningEl.createDiv({ cls: "callout-title" });
		const iconEl = calloutTitle.createDiv({ cls: "callout-icon" });
		setIcon(iconEl, "alert-triangle");
		calloutTitle.createDiv({ cls: "callout-title-inner", text: "Warning" });

		warningEl.createDiv({
			cls: "callout-content",
			text: "Without comment markers, the plugin cannot track which highlights have been imported. This means new highlights cannot be dynamically merged with existing ones. Use this option only if you plan to manually manage all highlight updates.",
		});

		// Set initial visibility
		warningEl.style.display =
			this.plugin.settings.commentStyle === "none" ? "block" : "none";

		return warningEl;
  }
}
