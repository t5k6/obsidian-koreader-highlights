import { Notice, Setting, setIcon } from "obsidian";
import { DEFAULT_LOGS_FOLDER } from "src/constants";
import { LogLevel } from "src/services/LoggingService";
import type { KoreaderHighlightImporterSettings } from "src/types";
import { runAsyncAction } from "src/ui/utils/actionUtils";
import { SettingsSection } from "../SettingsSection";

export class AdvancedSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName("Debug log level")
			.setDesc(
				"Controls verbosity of logs. 'None' is off, 'Info' is most verbose.",
			)
			.addDropdown((dd) => {
				dd.addOption(String(LogLevel.NONE), "None");
				dd.addOption(String(LogLevel.ERROR), "Errors");
				dd.addOption(String(LogLevel.WARN), "Warnings");
				dd.addOption(String(LogLevel.INFO), "Info");
				dd.setValue(String(settings.logLevel)).onChange(async (v) => {
					settings.logLevel = parseInt(
						v,
						10,
					) as KoreaderHighlightImporterSettings["logLevel"];
					this.debouncedSave();
				});
			});

		new Setting(containerEl)
			.setName("Log to file")
			.setDesc("Write debug logs to a file in your vault.")
			.addToggle((t) =>
				t.setValue(settings.logToFile).onChange(async (v) => {
					settings.logToFile = v;
					// Reload to enable/disable folder input
					await this.saveAndReload();
				}),
			);

		new Setting(containerEl)
			.setName("Log folder")
			.setDesc("Debug logs will be written to this folder.")
			.setDisabled(!settings.logToFile)
			.setTooltip("Enable 'Log to file' to edit this.")
			.addText((t) => {
				t.setPlaceholder(`Default: ${DEFAULT_LOGS_FOLDER}`)
					.setValue(settings.logsFolder)
					.onChange((v) => {
						settings.logsFolder = v;
						this.debouncedSave();
					});
			});

		containerEl.createEl("h3", { text: "Troubleshooting" });

		new Setting(containerEl)
			.setName("Reset Import Status")
			.setDesc(
				"Makes the plugin forget which books have been imported. Notes are NOT deleted.",
			)
			.addButton((btn) =>
				btn
					.setButtonText("Reset Status")
					.setWarning()
					.onClick(async () => {
						await runAsyncAction(btn, () => this.plugin.triggerClearCaches(), {
							inProgress: "Resetting…",
							original: "Reset Status",
						});
						new Notice(
							"Import status has been reset. Run an import to re-process all books.",
						);
					}),
			);

		new Setting(containerEl)
			.setName("Force Re-import All Books")
			.setDesc("Resets import status and immediately starts a new import.")
			.addButton((btn) =>
				btn
					.setButtonText("Force Re-import")
					.setWarning()
					.onClick(async () =>
						runAsyncAction(btn, () => this.plugin.triggerForceImport(), {
							inProgress: "Importing...",
							original: "Force Re-import",
						}),
					),
			);

		new Setting(containerEl)
			.setName("Factory Reset Plugin")
			.setDesc("Deletes the plugin's data and reloads it.")
			.addButton((btn) =>
				btn
					.setButtonText("Reset and Reload")
					.setWarning()
					.onClick(async () => this.plugin.triggerFullReset()),
			);

		new Setting(containerEl)
			.setName("Diagnose Environment Issues")
			.setDesc("Re-check for things like vault write permissions.")
			.addButton((btn) =>
				btn.setButtonText("Re-check").onClick(async () =>
					runAsyncAction(btn, () => this.plugin.triggerRecheckCapabilities(), {
						inProgress: "Checking…",
						original: "Re-check",
					}),
				),
			);

		containerEl.createEl("h3", { text: "Data Management" });

		new Setting(containerEl)
			.setName("Comment Style")
			.setDesc(
				"Choose between HTML or MD style comments for tracking imported highlights.",
			)
			.addDropdown((dd) => {
				dd.addOption("html", "HTML Style Comments");
				dd.addOption("md", "MD Style Comments");
				dd.addOption("none", "None");
				dd.setValue(settings.commentStyle).onChange(async (v) => {
					settings.commentStyle =
						v as KoreaderHighlightImporterSettings["commentStyle"];
					await this.saveAndReload();
				});
			});

		if (settings.commentStyle === "none") {
			const callout = containerEl.createDiv({ cls: "callout" });
			callout.setAttr("data-callout", "warning");
			const title = callout.createDiv({ cls: "callout-title" });
			const icon = title.createDiv({ cls: "callout-icon" });
			setIcon(icon, "alert-triangle");
			title.createDiv({ cls: "callout-title-inner", text: "Warning" });
			callout.createDiv({
				cls: "callout-content",
				text: "Without comment markers, the plugin cannot track imported highlights and cannot dynamically merge new ones.",
			});
		}

		new Setting(containerEl)
			.setName("Convert Existing Files")
			.setDesc("Convert highlight files to use the selected comment style.")
			.addButton((btn) =>
				btn
					.setButtonText("Convert All Files")
					.setWarning()
					.onClick(async () =>
						runAsyncAction(
							btn,
							() => this.plugin.triggerConvertCommentStyle(),
							{
								inProgress: "Converting...",
								original: "Convert All Files",
							},
						),
					),
			);

		new Setting(containerEl)
			.setName("Clean up comments from completed books")
			.setDesc(
				"Remove tracking comments from notes marked as 'completed' (readingStatus: completed).",
			)
			.addButton((btn) =>
				btn
					.setButtonText("Clean up completed books")
					.setWarning()
					.onClick(async () =>
						runAsyncAction(
							btn,
							() => this.plugin.triggerCleanupCompletedBooks(),
							{
								inProgress: "Scanning and cleaning...",
								original: "Clean up completed books",
							},
						),
					),
			);

		new Setting(containerEl)
			.setName("Maximum backups per note")
			.setDesc(
				"The maximum number of backups to keep for each note. Set to 0 to disable the limit.",
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "20";
				text.inputEl.step = "1";
				text
					.setValue(String(settings.maxBackupsPerNote))
					.onChange(async (v) => {
						const val = parseInt(v, 10);
						if (!isNaN(val) && val >= 0 && val <= 20) {
							settings.maxBackupsPerNote = val;
							this.debouncedSave();
						}
					});
			});
	}
}
