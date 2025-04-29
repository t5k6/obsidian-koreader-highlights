import {
    AbstractInputSuggest,
    type App,
    Modal,
    normalizePath,
    Notice,
    PluginSettingTab,
    Setting,
    TFolder,
} from "obsidian";
import type KoReaderHighlightImporter from "./main";
import type { FrontmatterSettings } from "./types";
import { setDebugLevel } from "./utils/logging";

class FolderInputSuggest extends AbstractInputSuggest<string> {
    constructor(
        app: App,
        private inputEl: HTMLInputElement,
        private onSubmit: (result: string) => void,
    ) {
        super(app, inputEl);
    }

    getSuggestions(query: string): string[] {
        const folders = this.app.vault.getAllFolders();
        const lowerCaseQuery = query.toLowerCase();
        return folders
            .map((folder) => folder.path)
            .filter((folderPath) =>
                folderPath.toLowerCase().includes(lowerCaseQuery)
            );
    }

    getValue(): string {
        return this.inputEl.value;
    }

    renderSuggestion(suggestion: string, el: HTMLElement): void {
        const suggestionEl = el.createEl("div", {
            text: suggestion,
            cls: "suggestion-item",
        });
        suggestionEl.addEventListener("mousedown", (evt: MouseEvent) => {
            evt.preventDefault();
        });
        suggestionEl.addEventListener("click", (evt: MouseEvent) => {
            this.onChooseSuggestion(suggestion, evt);
        });
    }

    onChooseSuggestion(
        suggestion: string,
        evt: MouseEvent | KeyboardEvent,
    ): void {
        this.inputEl.value = suggestion;
        this.inputEl.trigger("input");
        this.onSubmit(suggestion);
        this.close();
    }
}

export class KoReaderSettingTab extends PluginSettingTab {
    plugin: KoReaderHighlightImporter;

    constructor(app: App, plugin: KoReaderHighlightImporter) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // --- Core Settings ---
        new Setting(containerEl).setName("Core Settings").setHeading();

        new Setting(containerEl)
            .setName("KoReader mount point")
            .setDesc(
                "Specify the directory where your KoReader device is mounted (e.g., /media/user/KOBOeReader).",
            )
            .addText((text) =>
                text
                    .setPlaceholder("/path/to/koreader/mount/point")
                    .setValue(this.plugin.settings.koboMountPoint)
                    .onChange(async (value: string) => {
                        this.plugin.settings.koboMountPoint = normalizePath(
                            value,
                        );
                        await this.plugin.saveSettings();
                    })
            );

        // Create the setting for Highlights folder
        new Setting(containerEl)
            .setName("Highlights folder")
            .setDesc(
                "Specify the directory where you would like to save your highlights.",
            )
            .addText((textComponent) => {
                textComponent
                    .setPlaceholder("/KoReader Highlights/")
                    .setValue(this.plugin.settings.highlightsFolder);

                // A helper that normalizes the path, creates the folder if needed,
                // updates plugin settings, and gives user feedback.
                const processFolderInput = async (value: string) => {
                    const normalizedResult: string = normalizePath(value);
                    const folder = this.app.vault.getAbstractFileByPath(
                        normalizedResult,
                    );
                    if (!folder || !(folder instanceof TFolder)) {
                        await this.app.vault.createFolder(normalizedResult);
                    }
                    this.plugin.settings.highlightsFolder = normalizedResult;
                    await this.plugin.saveSettings();
                    new Notice(`Folder created: ${normalizedResult}`);
                };

                // Use blur event so folder creation happens only when the user is done editing.
                textComponent.inputEl.addEventListener("blur", async () => {
                    const value = textComponent.inputEl.value.trim();
                    if (!value) return;
                    try {
                        await processFolderInput(value);
                    } catch (error) {
                        new Notice(
                            `KOReader Importer: Failed to create folder: ${value}`,
                        );
                    }
                });

                // Add FolderInputSuggest for folder suggestions.
                new FolderInputSuggest(
                    this.app,
                    textComponent.inputEl,
                    (result: string) => {
                        textComponent.setValue(result);
                    },
                );
            });

        // --- Filtering/Exclusion Settings ---
        new Setting(containerEl).setName("Filtering/Exclusion Settings")
            .setHeading();

        new Setting(containerEl)
            .setName("Excluded folders")
            .setDesc(
                "Comma-separated list of folders to exclude (e.g., folder1,folder2).",
            )
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.excludedFolders.join(","))
                    .onChange(async (value) => {
                        this.plugin.settings.excludedFolders = value.split(",")
                            .map((s) => s.trim());
                        await this.plugin.saveSettings();
                        this.plugin.clearCaches();
                    })
            );

        new Setting(containerEl)
            .setName("Allowed file types")
            .setDesc(
                "Comma-separated list of file types to include (e.g., epub,pdf).",
            )
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.allowedFileTypes.join(","))
                    .onChange(async (value) => {
                        this.plugin.settings.allowedFileTypes = value === ""
                            ? []
                            : value.split(",").map((s) => s.trim());
                        await this.plugin.saveSettings();
                        this.plugin.clearCaches();
                    })
            );

        // --- Actions ---
        new Setting(containerEl).setName("Actions").setHeading();

        new Setting(containerEl)
            .setName("Scan for SDR files")
            .setDesc(
                "Click to scan the KoReader mount point for highlight files.",
            )
            .addButton((button) =>
                button.setButtonText("Scan for Annotations").onClick(() => {
                    this.plugin.scanHighlightsDirectory();
                })
            );

        new Setting(containerEl)
            .setName("Import highlights")
            .setDesc(
                "Click to import highlights from the KoReader mount point.",
            )
            .addButton((button) =>
                button.setButtonText("Import Annotations").onClick(() => {
                    this.plugin.importHighlights();
                })
            );

        // --- Advanced/Troubleshooting ---
        new Setting(containerEl).setName("Advanced/Troubleshooting")
            .setHeading();
        this.addFrontmatterSelection(containerEl);
        new Setting(containerEl)
            .setName("Enable full vault duplicate check")
            .setDesc(
                "When enabled, the plugin will check the entire vault for duplicates. When disabled, the plugin will only check duplicates inside the highlights folder.",
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableFullDuplicateCheck)
                    .onChange(async (value) => {
                        this.plugin.settings.enableFullDuplicateCheck = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Debug level")
            .setDesc(
                "Select the debug verbosity level (None: no logs, Error: only errors, Warning: warnings & errors, Info: all messages).",
            )
            .addDropdown((dropdown) => {
                dropdown.addOption("0", "None");
                dropdown.addOption("3", "Error");
                dropdown.addOption("2", "Warning");
                dropdown.addOption("1", "Info");
                dropdown.setValue(this.plugin.settings.debugLevel.toString());
                dropdown.onChange(async (value: string) => {
                    const level = Number.parseInt(value);
                    this.plugin.settings.debugLevel = level;
                    setDebugLevel(level);
                    await this.plugin.saveSettings();
                });
            });
    }
    private addFrontmatterSelection(containerEl: HTMLElement) {
        const fieldOptions = [
            // DocProps fields
            { id: "title", name: "Title" },
            { id: "authors", name: "Authors" },
            { id: "description", name: "Description" },
            { id: "keywords", name: "Keywords" },
            { id: "series", name: "Series" },
            { id: "language", name: "Language" },

            // Statistics fields
            { id: "pages", name: "Page Count" },
            { id: "highlights", name: "Highlight Count" },
            { id: "notes", name: "Note Count" },
            { id: "lastRead", name: "Last Read Date" },
            { id: "totalReadTime", name: "Total Reading Time" },
            { id: "progress", name: "Reading Progress" },
            { id: "readingStatus", name: "Reading Status" },
            { id: "averageTimePerPage", name: "Average Time/Page" },
        ];

        new Setting(containerEl)
            .setName("Frontmatter Fields")
            .setDesc(
                "All document properties are included by default. Select fields to exclude:",
            )
            .addButton((button) => {
                button.setButtonText("Manage Fields");
                button.setCta();
                button.onClick(() => {
                    this.showFieldSelectionModal(fieldOptions);
                });
            });
    }

    private showFieldSelectionModal(
        fieldOptions: Array<{ id: string; name: string }>,
    ) {
        const modal = new (class extends Modal {
            private disabledFields: string[];
            private customFields: string[];

            constructor(
                app: App,
                private settings: FrontmatterSettings,
                private options: Array<{ id: string; name: string }>,
                private onSave: (disabled: string[], customs: string[]) => void,
            ) {
                super(app);
                this.disabledFields = [...(settings.disabledFields || [])];
                this.customFields = [...(settings.customFields || [])];
            }

            onOpen() {
                const { contentEl } = this;
                contentEl.createEl("h3", { text: "Manage Frontmatter Fields" });

                // Predefined Fields Section
                contentEl.createEl("h4", {
                    text:
                        "Standard Fields (Choose the ones you want to exclude",
                });
                const predefinedList = contentEl.createDiv(
                    "frontmatter-field-list",
                );

                for (const field of this.options) {
                    const isDisabled = this.disabledFields.includes(field.id);
                    const itemEl = predefinedList.createDiv(
                        "frontmatter-field-item",
                    );

                    new Setting(itemEl)
                        .setName(field.name)
                        .addToggle((toggle) =>
                            toggle
                                .setValue(isDisabled)
                                .onChange((disabled) => {
                                    if (disabled) {
                                        this.disabledFields.push(field.id);
                                    } else {
                                        this.disabledFields = this
                                            .disabledFields.filter((f) =>
                                                f !== field.id
                                            );
                                    }
                                })
                        );
                }

                // Custom Fields Section
                contentEl.createEl("h4", { text: "Custom Fields" });
                const customFieldsEl = contentEl.createDiv(
                    "custom-fields-section",
                );

                new Setting(customFieldsEl)
                    .setName("Add custom fields")
                    .setDesc(
                        "Comma-separated property names from document metadata",
                    )
                    .addText((text) =>
                        text
                            .setValue(this.customFields.join(", "))
                            .onChange((value) => {
                                this.customFields = value.split(",")
                                    .map((f) => f.trim())
                                    .filter((f) =>
                                        f.length > 0 &&
                                        !this.options.some((o) => o.id === f) &&
                                        !this.customFields.includes(f)
                                    );
                            })
                    );

                // Save Controls
                new Setting(contentEl)
                    .addButton((button) =>
                        button
                            .setButtonText("Save")
                            .onClick(() => {
                                this.onSave(
                                    [...new Set(this.disabledFields)],
                                    [...new Set(this.customFields)],
                                );
                                this.close();
                            })
                    );
            }
        })(
            this.app,
            this.plugin.settings.frontmatter,
            fieldOptions,
            (disabled, customs) => {
                this.plugin.settings.frontmatter.disabledFields = disabled;
                this.plugin.settings.frontmatter.customFields = customs;
                this.plugin.saveSettings();
            },
        );

        modal.open();
    }
}
