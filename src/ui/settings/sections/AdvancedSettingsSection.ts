import { Setting, setIcon } from "obsidian";
import type { KoreaderHighlightImporterSettings } from "src/types";
import { DebugLevel } from "src/utils/logging";
import { booleanSetting, dropdownSetting } from "../SettingHelpers";
import { SettingsSection } from "../SettingsSection";

export class AdvancedSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Clear Caches")
			.setDesc(
				"Force re-scan for files and re-parse of metadata on next import.",
			)
			.addButton((button) =>
				button
					.setButtonText("Clear Now")
					.setWarning()
					.onClick(async () => {
						await this.plugin.triggerClearCaches();
					}),
			);

		booleanSetting(
			containerEl,
			"Enable Debug File Logging",
			"Write debug messages to a file. Can be toggled live.",
			() => this.plugin.settings.debugMode,
			async (value) => {
				this.plugin.settings.debugMode = value;
				await this.plugin.saveSettings();
			},
		);

		dropdownSetting(
			containerEl,
			"Debug level",
			"Controls verbosity of logs. 'Info' is most verbose.",
			{
				[DebugLevel.INFO]: "Info",
				[DebugLevel.WARN]: "Warnings",
				[DebugLevel.ERROR]: "Errors",
				[DebugLevel.NONE]: "None",
			},
			() => String(this.plugin.settings.debugLevel),
			async (value) => {
				const level = Number.parseInt(
					value,
					10,
				) as KoreaderHighlightImporterSettings["debugLevel"];
				this.plugin.settings.debugLevel = level;
				await this.plugin.saveSettings();
			},
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
