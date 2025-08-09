import { type App, debounce, PluginSettingTab } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { DebouncedFn } from "src/types";
import { SectionStateManager } from "src/ui/settings/SectionStateManager";
import type { SettingsSection } from "src/ui/settings/SettingsSection";
import { AdvancedSettingsSection } from "src/ui/settings/sections/AdvancedSettingsSection";
import { CoreSettingsSection } from "src/ui/settings/sections/CoreSettingsSection";
import { FilteringSettingsSection } from "src/ui/settings/sections/FilteringSettingsSection";
import { FormattingSettingsSection } from "src/ui/settings/sections/FormattingSettingsSection";
import { ImportActionsSection } from "src/ui/settings/sections/ImportActionsSection";
import { TemplateSettingsSection } from "src/ui/settings/sections/TemplateSettingsSection";

export class SettingsTab extends PluginSettingTab {
	public readonly koreaderPlugin: KoreaderImporterPlugin;
	private readonly debouncedSave: (() => void) & { cancel: () => void };
	private sections: SettingsSection[] = [];
	private readonly stateManager: SectionStateManager;

	constructor(app: App, plugin: KoreaderImporterPlugin) {
		super(app, plugin);
		this.koreaderPlugin = plugin;

		this.debouncedSave = debounce(
			() => this.koreaderPlugin.saveSettings(),
			500,
			false,
		) as DebouncedFn;
		this.stateManager = new SectionStateManager();

		// We will instantiate sections in `display()` to ensure a fresh state on each render.
		this.koreaderPlugin.settingTab = this;
	}

	display(): void {
		const { containerEl } = this;

		this.stateManager.saveState(containerEl);
		containerEl.empty();
		containerEl.addClass("koreader-importer-settings");

		// Clear previous children before creating new ones to avoid leaks
		// This will unload all registered child components from the previous render (if supported by the base class).
		// Use optional chaining to avoid type issues in environments where PluginSettingTab typings don't expose Component methods.
		(this as any).unload?.();

		// Instantiate sections here
		this.sections = [
			new CoreSettingsSection(
				this.koreaderPlugin,
				this.debouncedSave,
				"Core Settings",
				true,
			),
			new ImportActionsSection(
				this.koreaderPlugin,
				this.debouncedSave,
				"Import Actions",
				true,
			),
			new FilteringSettingsSection(
				this.koreaderPlugin,
				this.debouncedSave,
				"Filtering & Exclusion",
			),
			new FormattingSettingsSection(
				this.koreaderPlugin,
				this.debouncedSave,
				"Formatting & Duplicates",
			),
			new TemplateSettingsSection(
				this.koreaderPlugin,
				this.debouncedSave,
				"Template Settings",
				this.koreaderPlugin.templateManager,
			),
			new AdvancedSettingsSection(
				this.koreaderPlugin,
				this.debouncedSave,
				"Advanced & Troubleshooting",
			),
		];

		this.sections.forEach((section) => {
			// Register section as a child so Obsidian manages its lifecycle automatically (if available)
			(this as any).addChild?.(section);
			section.display(containerEl);
		});

		this.stateManager.restoreState(containerEl);
	}

	hide(): void {
		super.hide();
		// Sections are registered as children; lifecycle clean-up is automatic.
		this.sections = [];
	}
}
