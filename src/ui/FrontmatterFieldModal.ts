import { type App, Modal, Notice, Setting } from "obsidian";
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
		contentEl.setAttribute("role", "dialog");
		contentEl.setAttribute("aria-labelledby", "frontmatter-title");

		const titleEl = contentEl.createEl("h3", {
			text: "Manage Frontmatter Fields",
			cls: "frontmatter-title",
		});
		titleEl.id = "frontmatter-title";

		contentEl.createEl("p", {
			text: "These settings control which metadata fields appear in your highlight notes. Check a field to EXCLUDE it from generated frontmatter.",
			cls: "frontmatter-description",
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
			text: "Add extra fields from KOReader metadata:",
		});

		// List container for custom fields
		const fieldsContainer = contentEl.createDiv("custom-fields-container");

		// Function to render custom fields list
		const renderCustomFields = () => {
			fieldsContainer.empty();

			this.currentSettings.customFields.forEach((field, index) => {
				// Keep a reference to the created Setting so we can remove its element directly
				const setting = new Setting(fieldsContainer).setName(field);
				setting.addButton((button) =>
					button
						.setIcon("trash")
						.setTooltip("Remove field")
						.onClick(() => {
							this.currentSettings.customFields.splice(index, 1);
							// Remove the parent Setting element directly from the DOM
							setting.settingEl.remove();
						}),
				);
			});
		};

		renderCustomFields();

		const addFieldContainer = contentEl.createDiv("add-field-container");
		const addFieldSetting = new Setting(addFieldContainer);

		let newFieldValue = "";
		const input = addFieldSetting.addText((text) => {
			text.setPlaceholder("New field name").onChange((value) => {
				newFieldValue = value.trim();
			});
		}).controlEl;

		const suggestedFields = ["rating", "genre", "publisher"];

		input.setAttribute("list", "field-suggestions");
		const datalist = contentEl.createEl("datalist");
		datalist.id = "field-suggestions";
		suggestedFields.forEach((field) =>
			datalist.createEl("option", { value: field }),
		);

		addFieldSetting.addButton((button) =>
			button
				.setButtonText("Add")
				.setCta()
				.onClick(() => {
					if (!newFieldValue) return;

					// Validate field name format
					if (!/^[a-zA-Z0-9_-]+$/.test(newFieldValue)) {
						new Notice(
							"Field names can only contain letters, numbers, hyphens and underscores",
						);
						return;
					}

					// Check for duplicates
					if (this.currentSettings.customFields.includes(newFieldValue)) {
						new Notice("Field already exists");
						return;
					}

					this.currentSettings.customFields.push(newFieldValue);
					renderCustomFields();
					input.querySelector("input")!.value = "";
					newFieldValue = "";
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

		// Set focus to first control
		const firstToggle = contentEl.querySelector(
			'input[type="checkbox"]',
		) as HTMLElement;
		if (firstToggle) firstToggle.focus();
	}

	private handleSave() {
		this.currentSettings.disabledFields = Object.entries(this.fieldStates)
			.filter(([, isDisabled]) => isDisabled)
			.map(([id]) => id);
		this.onSave(this.currentSettings);
		this.close();
	}
}
