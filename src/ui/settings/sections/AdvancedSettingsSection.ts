import { Notice, Setting, setIcon } from "obsidian";
import { DEFAULT_LOGS_FOLDER } from "src/constants";
import { runPluginAction } from "src/lib/ui/actionUtils";
import { LogLevel } from "src/services/LoggingService";
import type { KoreaderHighlightImporterSettings } from "src/types";
import {
	booleanSetting,
	dropdownSetting,
	folderSetting,
} from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class AdvancedSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		dropdownSetting(
			containerEl,
			"Debug log level",
			"Controls verbosity of logs. 'None' is off, 'Info' is most verbose.",
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
			},
			this.debouncedSave,
		);

		booleanSetting(
			containerEl,
			"Log to file",
			"On top of writing to the Developer Tools Console, write debug logs to a file in your vault.",
			() => this.plugin.settings.logToFile,
			async (value) => {
				this.plugin.settings.logToFile = value;
			},
			async () => this.plugin.saveSettings(true),
		);

		if (this.plugin.settings.logToFile) {
			folderSetting(
				containerEl,
				this,
				"Log folder",
				"Debug logs will be written to this folder.",
				"Default: " + DEFAULT_LOGS_FOLDER,
				this.app,
				() => this.plugin.settings.logsFolder,
				(value) => {
					this.plugin.settings.logsFolder = value;
				},
				this.debouncedSave,
			);
		}

		// Troubleshooting
		containerEl.createEl("h3", { text: "Troubleshooting" });

		new Setting(containerEl)
			.setName("Reset Import Status")
			.setDesc(
				"Makes the plugin forget which books have been imported, so they will all be re-processed on the next import. This does NOT delete any notes.",
			)
			.addButton((button) =>
				button
					.setButtonText("Reset Status")
					.setWarning()
					.onClick(async () => {
						await runPluginAction(() => this.plugin.triggerClearCaches(), {
							button: button,
							inProgressText: "Resetting…",
							completedText: "Reset Status",
						});
						new Notice(
							"Import status has been reset. Run an import to re-process all books.",
						);
					}),
			);

		new Setting(containerEl)
			.setName("Force Re-import All Books")
			.setDesc(
				"A shortcut that resets the import status and immediately starts a new import. Useful for refreshing all data from your device.",
			)
			.addButton((button) =>
				button
					.setButtonText("Force Re-import")
					.setWarning()
					.onClick(async () => {
						await runPluginAction(() => this.plugin.triggerForceImport(), {
							button: button,
							inProgressText: "Importing...",
							completedText: "Force Re-import",
						});
					}),
			);

		new Setting(containerEl)
			.setName("Factory Reset Plugin")
			.setDesc(
				"DANGER: Deletes all of the plugin's data, including the persistent index and caches, then reloads the plugin. Your highlight notes are NOT affected. Use this as a last resort if the plugin is malfunctioning.",
			)
			.addButton((button) =>
				button
					.setButtonText("Reset and Reload")
					.setClass("mod-danger")
					.onClick(async () => {
						await this.plugin.triggerFullReset();
					}),
			);

		new Setting(containerEl)
			.setName("Diagnose Environment Issues")
			.setDesc(
				"Forces the plugin to re-check for things like vault write permissions. Use this if you've fixed a system-level issue (e.g., made a read-only vault writable) and want the plugin to recognize the change immediately.",
			)
			.addButton((button) =>
				button.setButtonText("Re-check").onClick(async () => {
					await runPluginAction(
						() => this.plugin.triggerRecheckCapabilities(),
						{
							button: button,
							inProgressText: "Checking…",
							completedText: "Re-check",
						},
					);
				}),
			);

		// Data Management
		containerEl.createEl("h3", { text: "Data Management" });

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
						await runPluginAction(
							() => this.plugin.triggerConvertCommentStyle(),
							{
								button: button,
								inProgressText: "Converting...",
								completedText: "Convert All Files",
							},
						);
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
