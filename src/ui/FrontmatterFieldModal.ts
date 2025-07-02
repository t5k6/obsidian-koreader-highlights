import { type App, Modal, Setting } from "obsidian";
import type { FrontmatterSettings } from "../types";

export class FrontmatterFieldModal extends Modal {
	private currentSettings!: FrontmatterSettings;
	private fieldStates: Record<string, boolean> = {};
	private readonly fieldOptions = [
		{ id: "description", name: "Description" },
		{ id: "keywords", name: "Keywords" },
		{ id: "series", name: "Series" },
		{ id: "language", name: "Language" },
		{ id: "pages", name: "Page Count" },
		{ id: "lastRead", name: "Last Read Date" },
		{ id: "firstRead", name: "First Read Date" },
		{ id: "totalReadTime", name: "Total Reading Time" },
		{ id: "progress", name: "Reading Progress (%)" },
		{ id: "readingStatus", name: "Reading Status" },
		{ id: "averageTimePerPage", name: "Avg. Time Per Page" },
	];

	constructor(
		app: App,
		private initialSettings: FrontmatterSettings,
		private onSave: (newSettings: FrontmatterSettings) => void,
	) {
		super(app);
	}

	onOpen() {
		// Deep copy to avoid mutating settings until save.
		this.currentSettings = JSON.parse(JSON.stringify(this.initialSettings));

		// Initialize field states from the current settings
		for (const field of this.fieldOptions) {
			this.fieldStates[field.id] = this.currentSettings.disabledFields.includes(
				field.id,
			);
		}

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("koreader-frontmatter-modal");
		contentEl.createEl("h3", { text: "Manage Frontmatter Fields" });
		contentEl.createEl("p", {
			text: "Check a field to EXCLUDE it from generated frontmatter.",
		});

		for (const field of this.fieldOptions) {
			new Setting(contentEl).setName(field.name).addToggle((toggle) =>
				toggle.setValue(this.fieldStates[field.id]).onChange((isDisabled) => {
					this.fieldStates[field.id] = isDisabled;
				}),
			);
		}

		contentEl.createEl("h3", { text: "Custom Fields" });
		contentEl.createEl("p", {
			text: "Add extra fields from KOReader metadata (comma-separated).",
		});
		new Setting(contentEl).addTextArea((text) =>
			text
				.setValue(this.currentSettings.customFields.join(", "))
				.onChange((value) => {
					this.currentSettings.customFields = value
						.split(",")
						.map((f) => f.trim())
						.filter(Boolean);
				}),
		);

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Save")
					.setCta()
					.onClick(() => this.handleSave()),
			)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close()),
			);
	}

	private handleSave() {
		this.currentSettings.disabledFields = Object.entries(this.fieldStates)
			.filter(([, isDisabled]) => isDisabled)
			.map(([id]) => id);
		this.onSave(this.currentSettings);
		this.close();
	}
}
