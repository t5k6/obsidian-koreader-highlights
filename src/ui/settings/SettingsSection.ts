import type { App } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";

export abstract class SettingsSection {
	protected app: App;

	constructor(
		protected plugin: KoreaderImporterPlugin,
		protected debouncedSave: () => void,
		public title: string,
		private startOpen = false,
	) {
		this.app = plugin.app;
	}

	public display(containerEl: HTMLElement): void {
		const details = containerEl.createEl("details", {
			cls: "koreader-settings-section",
			attr: { "data-title": this.title, ...(this.startOpen && { open: true }) },
		});

		details.createEl("summary", { text: this.title });
		this.renderContent(details.createDiv());
	}

	protected abstract renderContent(containerEl: HTMLElement): void;
}
