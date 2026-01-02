import { type App, Component, Notice } from "obsidian";
import type KoreaderImporterPlugin from "src/main";
import type { DebouncedFn } from "src/types";

export abstract class SettingsSection extends Component {
	protected app: App;

	constructor(
		protected plugin: KoreaderImporterPlugin,
		protected debouncedSave: DebouncedFn,
		public title: string,
		private startOpen = false,
	) {
		super();
		this.app = plugin.app;
	}

	public display(containerEl: HTMLElement): void {
		const details = containerEl.createEl("details", {
			cls: "koreader-settings-section",
		});
		// Set attributes separately to satisfy stricter createEl typings
		details.setAttr("data-title", this.title);
		if (this.startOpen) {
			details.setAttr("open", "true");
			details.open = true;
		} else {
			details.open = false;
		}

		details.createEl("summary", { text: this.title });
		this.renderContent(details.createDiv());
	}

	onunload() {
		this.debouncedSave.cancel();
	}

	protected abstract renderContent(containerEl: HTMLElement): void;

	// Helper to trigger a save and optional UI refresh
	protected async saveAndReload(): Promise<void> {
		await this.plugin.saveSettings(true);
	}

	// Helper for consistent error handling in setting changes
	protected async settingChanged(
		callback: () => void | Promise<void>,
	): Promise<void> {
		try {
			await callback();
			this.debouncedSave();
		} catch (err) {
			console.error("Failed to save setting:", err);
			new Notice("Failed to save setting.");
		}
	}
}
