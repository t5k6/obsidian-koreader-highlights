import { Notice } from "obsidian";
import { DEFAULT_LOGS_FOLDER } from "src/constants";
import { runPluginAction } from "src/lib/ui/actionUtils";
import { LogLevel } from "src/services/LoggingService";
import type { KoreaderHighlightImporterSettings } from "src/types";
import { renderSettingsSection } from "../SettingsKit";
import { SettingsSection } from "../SettingsSection";

export class AdvancedSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		renderSettingsSection(
			containerEl,
			[
				{
					key: "logLevel",
					type: "dropdown",
					name: "Debug log level",
					desc: "Controls verbosity of logs. 'None' is off, 'Info' is most verbose.",
					options: {
						[String(LogLevel.NONE)]: "None",
						[String(LogLevel.ERROR)]: "Errors",
						[String(LogLevel.WARN)]: "Warnings",
						[String(LogLevel.INFO)]: "Info",
					},
					get: () => String(this.plugin.settings.logLevel),
					set: async (value: string) => {
						const level = Number.parseInt(
							value,
							10,
						) as KoreaderHighlightImporterSettings["logLevel"];
						this.plugin.settings.logLevel = level;
					},
				},
				{
					key: "logToFile",
					type: "toggle",
					name: "Log to file",
					desc: "On top of writing to the Developer Tools Console, write debug logs to a file in your vault.",
					get: () => this.plugin.settings.logToFile,
					set: async (value: boolean) => {
						this.plugin.settings.logToFile = value;
					},
				},
				{
					key: "logsFolder",
					type: "folder",
					name: "Log folder",
					desc: "Debug logs will be written to this folder.",
					placeholder: `Default: ${DEFAULT_LOGS_FOLDER}`,
					get: () => this.plugin.settings.logsFolder,
					set: (value: string) => {
						this.plugin.settings.logsFolder = value;
					},
					disabled: () => !this.plugin.settings.logToFile,
					tooltip: "Enable 'Log to file' to edit this.",
				},

				{ type: "header", text: "Troubleshooting" },

				{
					key: "resetImportStatus",
					type: "buttons",
					name: "Reset Import Status",
					desc: "Makes the plugin forget which books have been imported. Notes are NOT deleted.",
					buttons: [
						{
							text: "Reset Status",
							warning: true,
							onClick: async (btn) => {
								await runPluginAction(() => this.plugin.triggerClearCaches(), {
									button: btn,
									inProgressText: "Resetting…",
									completedText: "Reset Status",
								});
								new Notice(
									"Import status has been reset. Run an import to re-process all books.",
								);
							},
						},
					],
				},
				{
					key: "forceReimport",
					type: "buttons",
					name: "Force Re-import All Books",
					desc: "Resets import status and immediately starts a new import.",
					buttons: [
						{
							text: "Force Re-import",
							warning: true,
							onClick: async (btn) => {
								await runPluginAction(() => this.plugin.triggerForceImport(), {
									button: btn,
									inProgressText: "Importing...",
									completedText: "Force Re-import",
								});
							},
						},
					],
				},
				{
					key: "factoryReset",
					type: "buttons",
					name: "Factory Reset Plugin",
					desc: "Deletes the plugin's data (not your notes) and reloads it.",
					buttons: [
						{
							text: "Reset and Reload",
							warning: true,
							onClick: async () => {
								await this.plugin.triggerFullReset();
							},
						},
					],
				},
				{
					key: "diagnose",
					type: "buttons",
					name: "Diagnose Environment Issues",
					desc: "Re-check for things like vault write permissions.",
					buttons: [
						{
							text: "Re-check",
							onClick: async (btn) => {
								await runPluginAction(
									() => this.plugin.triggerRecheckCapabilities(),
									{
										button: btn,
										inProgressText: "Checking…",
										completedText: "Re-check",
									},
								);
							},
						},
					],
				},

				{ type: "header", text: "Data Management" },

				{
					key: "commentStyle",
					type: "dropdown",
					name: "Comment Style",
					desc: "Choose between HTML or MD style comments for tracking imported highlights.",
					options: {
						html: "HTML Style Comments",
						md: "MD Style Comments",
						none: "None",
					},
					get: () => this.plugin.settings.commentStyle,
					set: (value) => {
						this.plugin.settings.commentStyle =
							value as KoreaderHighlightImporterSettings["commentStyle"];
					},
				},
				{
					type: "callout",
					id: "comment-style-warning",
					calloutType: "warning",
					title: "Warning",
					text: "Without comment markers, the plugin cannot track imported highlights and cannot dynamically merge new ones.",
					if: () => this.plugin.settings.commentStyle === "none",
				},
				{
					key: "convertExisting",
					type: "buttons",
					name: "Convert Existing Files",
					desc: "Convert highlight files to use the selected comment style.",
					buttons: [
						{
							text: "Convert All Files",
							warning: true,
							onClick: async (btn) => {
								await runPluginAction(
									() => this.plugin.triggerConvertCommentStyle(),
									{
										button: btn,
										inProgressText: "Converting...",
										completedText: "Convert All Files",
									},
								);
							},
						},
					],
				},
			],
			{
				app: this.app,
				parent: this,
				onSave: async () => this.plugin.saveSettings(true),
			},
		);
	}
}
