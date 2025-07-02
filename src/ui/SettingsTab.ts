import { type App, debounce, PluginSettingTab } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import { SectionStateManager } from "./settings/SectionStateManager";
import type { SettingsSection } from "./settings/SettingsSection";
import { AdvancedSettingsSection } from "./settings/sections/AdvancedSettingsSection";
import { CoreSettingsSection } from "./settings/sections/CoreSettingsSection";
import { FilteringSettingsSection } from "./settings/sections/FilteringSettingsSection";
import { FormattingSettingsSection } from "./settings/sections/FormattingSettingsSection";
import { ImportActionsSection } from "./settings/sections/ImportActionsSection";
import { TemplateSettingsSection } from "./settings/sections/TemplateSettingsSection";

export class SettingsTab extends PluginSettingTab {
	private readonly debouncedSave: () => void;
	private readonly sections: SettingsSection[];
	private readonly stateManager: SectionStateManager;

	constructor(app: App, plugin: KoreaderImporterPlugin) {
		super(app, plugin);

		this.debouncedSave = debounce(() => plugin.saveSettings(), 500, true);
		this.stateManager = new SectionStateManager();

		// Register all settings sections
		this.sections = [
			new CoreSettingsSection(
				plugin,
				this.debouncedSave,
				"Core Settings",
				true,
			),
			new ImportActionsSection(
				plugin,
				this.debouncedSave,
				"Import Actions",
				true,
			),
			new FilteringSettingsSection(
				plugin,
				this.debouncedSave,
				"Filtering & Exclusion",
			),
			new FormattingSettingsSection(
				plugin,
				this.debouncedSave,
				"Formatting & Duplicates",
			),
			new TemplateSettingsSection(
				plugin,
				this.debouncedSave,
				"Template Settings",
				plugin.templateManager,
			),
			new AdvancedSettingsSection(
				plugin,
				this.debouncedSave,
				"Advanced & Troubleshooting",
			),
		];

		// Make the tab instance available to sections if they need to re-render it
		plugin.settingTab = this;
	}

	display(): void {
		const { containerEl } = this;

		// Save the open/closed state of the details elements before clearing
		this.stateManager.saveState(containerEl);

		containerEl.empty();
		containerEl.addClass("koreader-importer-settings");

		// Render all sections
		this.sections.forEach((section) => section.display(containerEl));

		// Restore the open/closed state
		this.stateManager.restoreState(containerEl);
	}
}
