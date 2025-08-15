import { type App, Component } from "obsidian";
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
			attr: { "data-title": this.title, ...(this.startOpen && { open: true }) },
		});
		// Ensure sections can be restored by title and respect default open state
		details.dataset.title = this.title;
		details.open = this.startOpen;

		details.createEl("summary", { text: this.title });
		this.renderContent(details.createDiv());
	}

	onunload() {
		this.debouncedSave.cancel();
	}

	protected abstract renderContent(containerEl: HTMLElement): void;
}
