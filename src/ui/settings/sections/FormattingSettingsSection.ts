import { Setting } from "obsidian";
import { Pathing } from "src/lib/pathing";
import { FrontmatterFieldModal } from "src/ui/FrontmatterFieldModal";
import { renderValidationError } from "src/ui/utils/modalComponents";
import { SettingsSection } from "../SettingsSection";

export class FormattingSettingsSection extends SettingsSection {
	protected renderContent(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;

		// Helper for string lists
		const addListSetting = (
			name: string,
			desc: string,
			placeholder: string,
			get: () => string[],
			set: (v: string[]) => void,
		) => {
			let timer: NodeJS.Timeout;
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addTextArea((text) => {
					text
						.setPlaceholder(placeholder)
						.setValue(get().join(", "))
						.onChange((v) => {
							clearTimeout(timer);
							timer = setTimeout(() => {
								const list = v
									.split(",")
									.map((s) => s.trim())
									.filter(Boolean);
								set(list);
								this.debouncedSave();
							}, 500);
						});
				});
		};

		addListSetting(
			"Excluded folders",
			"Comma-separated list of folder names to ignore during scans.",
			".git, .stfolder",
			() => settings.excludedFolders,
			(v) => {
				settings.excludedFolders = v;
			},
		);

		addListSetting(
			"Allowed file types",
			"Process highlights for these book types only.",
			"epub, pdf, mobi",
			() => settings.allowedFileTypes,
			(v) => {
				settings.allowedFileTypes = v.map((x) => x.toLowerCase());
			},
		);

		containerEl.createEl("h4", { text: "Note Formatting" });

		new Setting(containerEl)
			.setName("Use custom file name template")
			.setDesc("Define a custom naming scheme for imported highlight notes.")
			.addToggle((toggle) => {
				toggle
					.setValue(settings.useCustomFileNameTemplate)
					.onChange(async (value) => {
						settings.useCustomFileNameTemplate = value;
						// Trigger reload to show/hide the dependent setting below
						await this.saveAndReload();
					});
			});

		// Conditional rendering: imperative if statement!
		if (settings.useCustomFileNameTemplate) {
			const templateSetting = new Setting(containerEl)
				.setName("File name template")
				// Custom description rendering logic
				.setDesc("Placeholders: {{title}}, {{authors}}, {{importDate}}.");

			const validationEl = templateSetting.descEl.createDiv({
				cls: "setting-item-description koreader-setting-validation",
			});

			const validate = (val: string) => {
				const { errors, warnings } = Pathing.validateFileNameTemplate(val);
				renderValidationError(validationEl, [...errors, ...warnings]);
				validationEl.style.color =
					errors.length > 0 ? "var(--text-error)" : "var(--text-muted)";
			};

			templateSetting.addText((text) => {
				text
					.setPlaceholder("{{title}} - {{authors}}")
					.setValue(settings.fileNameTemplate)
					.onChange(async (value) => {
						settings.fileNameTemplate = value;
						validate(value);
						this.debouncedSave();
					});
			});
			validate(settings.fileNameTemplate);
		}

		new Setting(containerEl)
			.setName("Frontmatter fields")
			.setDesc("Choose which fields to include or exclude from frontmatter.")
			.addButton((btn) => {
				btn.setButtonText("Manage Fields").onClick(async () => {
					const result = await new FrontmatterFieldModal(
						this.app,
						settings.frontmatter,
					).openAndAwaitResult();
					if (result) {
						settings.frontmatter = result;
						this.debouncedSave();
					}
				});
			});

		new Setting(containerEl)
			.setName("Convert Keywords to Tags")
			.setDesc(
				"Choose how to handle Keywords: 'None', 'Duplicate' (add Tags), or 'Replace' (convert to Tags).",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOption("none", "None")
					.addOption("duplicate", "Duplicate")
					.addOption("replace", "Replace")
					.setValue(settings.frontmatter.keywordsAsTags)
					.onChange(async (value) => {
						settings.frontmatter.keywordsAsTags = value as
							| "none"
							| "duplicate"
							| "replace";
						this.debouncedSave();
					});
			});

		new Setting(containerEl)
			.setName("Use 'Unknown Author' placeholder")
			.setDesc(
				"When an author is not found, use 'Unknown Author' instead of omitting the field.",
			)
			.addToggle((t) =>
				t
					.setValue(settings.frontmatter.useUnknownAuthor)
					.onChange(async (v) => {
						settings.frontmatter.useUnknownAuthor = v;
						this.debouncedSave();
					}),
			);

		containerEl.createEl("h4", { text: "Duplicate Handling" });

		new Setting(containerEl)
			.setName("Auto-merge on addition")
			.setDesc(
				"Automatically merge imports if they only add new highlights, without showing a dialog.",
			)
			.addToggle((t) =>
				t.setValue(settings.autoMergeOnAddition).onChange((v) => {
					settings.autoMergeOnAddition = v;
					this.debouncedSave();
				}),
			);

		new Setting(containerEl)
			.setName("Enable full vault duplicate check")
			.setDesc(
				"Checks the entire vault for duplicates (slower). When off, only the highlights folder is scanned (faster).",
			)
			.addToggle((t) =>
				t.setValue(settings.enableFullDuplicateCheck).onChange((v) => {
					settings.enableFullDuplicateCheck = v;
					this.debouncedSave();
				}),
			);
	}
}
