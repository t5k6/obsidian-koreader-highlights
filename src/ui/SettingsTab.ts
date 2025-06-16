import { normalize } from "node:path";
import {
    AbstractInputSuggest,
    type App,
    Modal,
    normalizePath,
    Notice,
    PluginSettingTab,
    Setting,
    type TextComponent,
    TFolder,
} from "obsidian";
import type KoReaderImporterPlugin from "../core/KoReaderImporterPlugin";
import type { FrontmatterSettings } from "../types";
import { runPluginAction } from "../utils/actionUtils";
import { ensureFolderExists } from "../utils/fileUtils";
import { setDebugLevel } from "../utils/logging";

class FolderInputSuggest extends AbstractInputSuggest<string> {
    constructor(
        app: App,
        private inputEl: HTMLInputElement,
        private plugin: KoReaderImporterPlugin,
        private onSubmit: (result: string) => void,
    ) {
        super(app, inputEl);
    }

    getSuggestions(query: string): string[] {
        const lowerCaseQuery = query.toLowerCase();
        // Suggest existing folders
        return this.app.vault.getAllLoadedFiles()
            .filter((file): file is TFolder => file instanceof TFolder)
            .map((folder) => folder.path)
            .filter((folderPath) =>
                folderPath.toLowerCase().includes(lowerCaseQuery)
            )
            .sort(); // Sort suggestions alphabetically
    }

    getValue(): string {
        return this.inputEl.value;
    }

    renderSuggestion(suggestion: string, el: HTMLElement): void {
        el.createDiv({ text: suggestion });
    }

    selectSuggestion(
        suggestion: string,
        evt: MouseEvent | KeyboardEvent,
    ): void {
        this.onSubmit(suggestion);

        const normalized = normalizePath(suggestion);
        this.plugin.settings.highlightsFolder = normalized;
        this.plugin.saveSettings();

        this.close();
    }
}

// --- Main Settings Tab Class ---
export class SettingsTab extends PluginSettingTab {
    // Store a reference to the main plugin class instance
    private plugin: KoReaderImporterPlugin;

    constructor(app: App, plugin: KoReaderImporterPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass("koreader-importer-settings");
        // --- Core Settings ---
        containerEl.createEl("h2", { text: "Core Settings" });

        let mountPointTextComponent: TextComponent;

        new Setting(containerEl)
            .setName("KoReader mount point")
            .setDesc(
                "The directory where your KoReader device (or its filesystem dump) is mounted. Example: /Volumes/KOBOeReader or E:/",
            )
            .addText((text) => {
                mountPointTextComponent = text;
                text.setPlaceholder("/path/to/koreader/mount")
                    .setValue(this.plugin.settings.koboMountPoint)
                    .onChange(async (value: string) => {
                        this.plugin.settings.koboMountPoint = normalize(
                            value.trim(),
                        );
                        await this.plugin.saveSettings();
                    });
            })
            .addButton((button) => {
                button.setButtonText("Browse")
                    .setTooltip("Select KoReader mount point folder")
                    .onClick(async () => {
                        try {
                            const electron = require("electron");

                            const dialog = electron.remote?.dialog ??
                                electron.dialog;
                            if (!dialog) {
                                throw new Error(
                                    "Electron dialog module not available.",
                                );
                            }

                            const result = await dialog.showOpenDialog({
                                properties: [
                                    "openDirectory",
                                    "showHiddenFiles",
                                ],
                                title: "Select KoReader Mount Point",
                            });

                            if (
                                !result.canceled && result.filePaths.length > 0
                            ) {
                                const selectedPath = normalize(
                                    result.filePaths[0],
                                );
                                this.plugin.settings.koboMountPoint =
                                    selectedPath;
                                await this.plugin.saveSettings();
                                mountPointTextComponent.setValue(selectedPath);
                                new Notice(
                                    `Mount point set to: ${selectedPath}`,
                                );
                            }
                        } catch (error) {
                            console.error(
                                "Error opening directory picker:",
                                error,
                            );
                            new Notice(
                                "Failed to open directory selector. Please enter the path manually.",
                                5000,
                            );
                        }
                    });
            });

        new Setting(containerEl)
            .setName("Highlights folder")
            .setDesc(
                "The folder within your vault to save imported highlight notes.",
            )
            .addText((text) => {
                text.setPlaceholder("KoReader Highlights")
                    .setValue(this.plugin.settings.highlightsFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.highlightsFolder = value;

                        await this.plugin.saveSettings();
                    });

                new FolderInputSuggest(
                    this.app,
                    text.inputEl,
                    this.plugin,
                    (result) => {
                        text.setValue(result);
                    },
                );

                // Validate and potentially create folder on blur
                text.inputEl.addEventListener("blur", async () => {
                    let pathValue = text.getValue().trim();
                    if (!pathValue) {
                        pathValue = "KoReader Highlights";
                        text.setValue(pathValue);
                    }
                    const normalized = normalizePath(pathValue);
                    this.plugin.settings.highlightsFolder = normalized;
                    await this.plugin.saveSettings();

                    await ensureFolderExists(this.app.vault, normalized);
                    new Notice(`Created highlights folder: ${normalized}`);
                });
            });

        // --- Filtering/Exclusion Settings ---
        containerEl.createEl("h2", { text: "Filtering & Exclusion" });

        new Setting(containerEl)
            .setName("Excluded folders")
            .setDesc(
                "Comma-separated list of folder names to ignore during scanning (e.g., .git, .stfolder, $RECYCLE.BIN). Case-sensitive.",
            )
            .addTextArea((text) => { // Use TextArea for potentially longer lists
                text.setValue(this.plugin.settings.excludedFolders.join(", "))
                    .setPlaceholder(".adds, .kobo, System Volume Information")
                    .onChange(async (value) => {
                        this.plugin.settings.excludedFolders = value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean); // Remove empty strings
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Allowed file types")
            .setDesc(
                "Process highlights only for these book file types (comma-separated extensions, e.g., epub, pdf, mobi). Leave empty to allow all.",
            )
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.allowedFileTypes.join(", "))
                    .setPlaceholder("epub, pdf, mobi, cbz")
                    .onChange(async (value) => {
                        const types = value.split(",").map((s) =>
                            s.trim().toLowerCase()
                        ).filter(Boolean);
                        this.plugin.settings.allowedFileTypes = types;
                        await this.plugin.saveSettings();
                    })
            );

        // --- Import Actions ---

        containerEl.createEl("h2", { text: "Import Actions" });
        const actionsContainer = containerEl.createDiv(
            "settings-actions-container",
        );

        new Setting(actionsContainer)
            .setName("Scan for highlights")
            .setDesc(
                "Scan the KoReader mount point and generate a report listing found highlight files.",
            )
            .addButton((button) =>
                button
                    .setButtonText("Scan Now")
                    .setCta() // Make it stand out slightly
                    .onClick(async () => {
                        button.setDisabled(true).setButtonText("Scanning...");
                        await this.plugin.triggerScan();
                        button.setDisabled(false).setButtonText("Scan Now");
                    })
            );

        new Setting(actionsContainer)
            .setName("Import highlights")
            .setDesc(
                "Import highlights from all found and allowed files on the KoReader mount point.",
            )
            .addButton((button) =>
                button.setButtonText("Import Now").onClick(async () => {
                    await runPluginAction(
                        () => this.plugin.triggerImport(),
                        {
                            button,
                            inProgressText: "Importing...",
                            completedText: "Import Now",
                            failureNotice: "Failed to import highlights",
                        },
                    );
                })
            );

        // --- Formatting & Duplicates ---
        containerEl.createEl("h2", { text: "Formatting & Duplicates" });

        this.addFrontmatterSelection(containerEl);

        new Setting(containerEl)
            .setName("Enable full vault duplicate check")
            .setDesc(
                'If enabled, checks the entire vault for duplicate notes (slower). If disabled, only checks within the "Highlights folder" (faster).',
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enableFullDuplicateCheck)
                    .onChange(async (value) => {
                        this.plugin.settings.enableFullDuplicateCheck = value;
                        await this.plugin.saveSettings();
                    })
            );

        // --- Template Settings ---
        containerEl.createEl("h2", { text: "Template Settings" });

        new Setting(containerEl)
            .setName("Use custom template")
            .setDesc("Override the default formatting for highlight notes.")
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings.template.useCustomTemplate)
                    .onChange(async (value) => {
                        this.plugin.settings.template.useCustomTemplate = value;
                        await this.plugin.saveSettings();
                        this.display(); // Refresh settings UI to show/hide template options
                    });
            });

        if (this.plugin.settings.template.useCustomTemplate) {
            // Template source selection (Vault / External)
            // Currently, only 'vault' is fully supported without Electron reliance for 'external' loading
            new Setting(containerEl)
                .setName("Template source")
                .setDesc(
                    "Choose template location (currently only 'Vault' is fully supported).",
                )
                .addDropdown((dropdown) => {
                    dropdown
                        .addOption("vault", "From vault")
                        // .addOption('external', 'From file system (Experimental)') // Commented out until fully implemented
                        .setValue(
                            this.plugin.settings.template.source || "vault",
                        )
                        .onChange(async (value) => {
                            this.plugin.settings.template.source = value;
                            await this.plugin.saveSettings();
                            this.display();
                        });
                });

            if (this.plugin.settings.template.source === "vault") {
                this.addVaultTemplateSelector(containerEl);
            }
            // else if (this.plugin.settings.template.source === 'external') {
            //     this.addExternalTemplateSelector(containerEl); // Add this method after external source is implemented
            // }

            if (
                this.plugin.settings.template.useCustomTemplate &&
                this.plugin.settings.template.source === "vault"
            ) {
                new Setting(containerEl)
                    .setName("Template directory")
                    .setDesc("The folder within your vault to store templates.")
                    .addText((text) => {
                        text.setPlaceholder("Koreader/templates")
                            .setValue(this.plugin.settings.template.templateDir)
                            .onChange(async (value) => {
                                this.plugin.settings.template.templateDir =
                                    value.trim() || "Koreader/templates";
                                await this.plugin.saveSettings();
                            });

                        // Add folder suggestions
                        new FolderInputSuggest(
                            this.app,
                            text.inputEl,
                            this.plugin,
                            (result) => {
                                text.setValue(result);
                            },
                        );

                        // Validate and potentially create folder on blur
                        text.inputEl.addEventListener("blur", async () => {
                            let pathValue = text.getValue().trim();
                            if (!pathValue) {
                                pathValue = "Koreader/templates";
                                text.setValue(pathValue);
                            }
                            const normalized = normalizePath(pathValue);
                            this.plugin.settings.template.templateDir =
                                normalized;
                            await this.plugin.saveSettings();

                            await ensureFolderExists(
                                this.app.vault,
                                normalized,
                            );
                            new Notice(
                                `Created template folder: ${normalized}`,
                            );

                            // Refresh the template selector to show templates from the new directory
                            this.display();
                        });
                    });
            }
        }

        // --- Advanced/Troubleshooting ---
        containerEl.createEl("h2", { text: "Advanced & Troubleshooting" });

        new Setting(containerEl)
            .setName("Clear Caches")
            .setDesc(
                "Force the plugin to re-scan for files and re-parse metadata on the next import/scan. Useful if files have changed externally.",
            )
            .addButton((button) =>
                button
                    .setButtonText("Clear Now")
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.clearCaches();
                        new Notice("KoReader Importer caches cleared.");
                    })
            );

        new Setting(containerEl)
            .setName("Debug level")
            .setDesc(
                "Control the amount of information logged to the developer console (and log file if enabled). Requires restart or reload for file logging changes.",
            )
            .addDropdown((dropdown) => {
                dropdown.addOption("0", "0 - None"); // No logs
                dropdown.addOption("3", "3 - Errors"); // Only errors (changed from old mapping)
                dropdown.addOption("2", "2 - Warnings"); // Errors and warnings
                dropdown.addOption("1", "1 - Info"); // All messages
                dropdown.setValue(this.plugin.settings.debugLevel.toString());
                dropdown.onChange(async (value: string) => {
                    const level = Number.parseInt(value, 10);
                    if (!Number.isNaN(level) && level >= 0 && level <= 3) {
                        this.plugin.settings.debugLevel = level as
                            | 0
                            | 1
                            | 2
                            | 3;
                        setDebugLevel(level);
                        await this.plugin.saveSettings();
                    }
                });
            });

        new Setting(containerEl)
            .setName("Enable Debug File Logging")
            .setDesc(
                "Write debug messages to a file in the vault (Koreader/logs). Requires plugin reload to take effect.",
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.debugMode)
                    .onChange(async (value) => {
                        this.plugin.settings.debugMode = value;
                        await this.plugin.saveSettings();
                        new Notice(
                            `Debug file logging ${
                                value ? "enabled" : "disabled"
                            }. Reload Obsidian for changes to take effect.`,
                        );
                    })
            );
    }

    // --- Helper methods for complex settings UI ---

    /** Adds the dropdown to select a template file from the vault */
    private addVaultTemplateSelector(containerEl: HTMLElement): void {
        const templatesFolder = normalizePath(
            this.plugin.settings.template.templateDir,
        );
        const templateFiles = this.app.vault.getFiles()
            .filter((f) =>
                f.path.startsWith(`${templatesFolder}/`) &&
                (f.extension === "md" || f.extension === "txt")
            )
            .map((f) => f.path);

        const setting = new Setting(containerEl)
            .setName("Select vault template")
            .setDesc(
                `Choose a template file from the "${templatesFolder}" folder.`,
            );

        if (templateFiles.length > 0) {
            setting.addDropdown((dropdown) => {
                dropdown.addOption("", "-- Select Template --"); // Add a default empty option
                // Add built-in templates as options first?
                dropdown.addOption("default", "Default (Built-in)");
                dropdown.addOption("enhanced", "Enhanced (Built-in)");
                dropdown.addOption("compact-list", "Compact List (Built-in)");
                dropdown.addOption("blockquote", "Blockquote (Built-in)");
                dropdown.addOption("__sep__", "---- Vault Templates ----")
                    .setDisabled(false); // Separator

                for (const file of templateFiles) {
                    const displayName = file.substring(
                        templatesFolder.length + 1,
                    );
                    dropdown.addOption(file, displayName); // Store full path as value
                }
                dropdown
                    .setValue(
                        this.plugin.settings.template.selectedTemplate || "",
                    )
                    .onChange(async (value) => {
                        if (value === "__sep__") {
                            dropdown.setValue(
                                this.plugin.settings.template
                                    .selectedTemplate || "",
                            );
                            return;
                        }
                        this.plugin.settings.template.selectedTemplate = value;
                        await this.plugin.saveSettings();
                    });
            });
        } else {
            setting.controlEl.setText(
                `No templates found in "${templatesFolder}". Create files ending in .md or .txt there.`,
            );
            // Ensure selection is cleared if no files exist
            if (this.plugin.settings.template.selectedTemplate !== "default") { // Keep default if it was selected
                this.plugin.settings.template.selectedTemplate = "default";
                this.plugin.saveSettings();
            }
        }
    }

    /** Adds UI for selecting an external template file (Requires Electron) */
    // private addExternalTemplateSelector(containerEl: HTMLElement): void {
    //     // Implementation using Electron dialog similar to mount point selection
    //     // Needs careful error handling and consideration for non-desktop platforms
    // }

    /** Builds the UI for selecting which frontmatter fields to exclude */
    private addFrontmatterSelection(containerEl: HTMLElement) {
        // Define potential standard fields (keys used internally)
        const fieldOptions = [
            // DocProps - Keep consistent with FrontmatterGenerator internal keys
            { id: "description", name: "Description" },
            { id: "keywords", name: "Keywords" },
            { id: "series", name: "Series" },
            { id: "language", name: "Language" },
            // Statistics - Keep consistent
            { id: "pages", name: "Page Count" },
            // { id: 'highlightCount', name: 'Highlight Count' }, // Add if generator supports it
            // { id: 'noteCount', name: 'Note Count' },         // Add if generator supports it
            { id: "lastRead", name: "Last Read Date" },
            { id: "firstRead", name: "First Read Date" },
            { id: "totalReadTime", name: "Total Reading Time" },
            { id: "progress", name: "Reading Progress (%)" },
            { id: "readingStatus", name: "Reading Status" },
            { id: "averageTimePerPage", name: "Avg. Time Per Page" },
        ];

        new Setting(containerEl)
            .setName("Frontmatter fields")
            .setDesc(
                "Choose which standard fields to EXCLUDE from the frontmatter. Title and Author(s) are always included.",
            )
            .addButton((button) => {
                button.setButtonText("Manage Excluded Fields")
                    .onClick(() => {
                        this.showFieldSelectionModal(fieldOptions);
                    });
            });
    }

    /** Displays the modal for managing frontmatter field exclusion */
    private showFieldSelectionModal(
        fieldOptions: Array<{ id: string; name: string }>,
    ) {
        const modal = new FrontmatterFieldModal(
            this.app,
            this.plugin.settings.frontmatter, // Pass current frontmatter settings
            fieldOptions,
            // Save callback
            (updatedSettings) => {
                this.plugin.settings.frontmatter = updatedSettings;
                this.plugin.saveSettings(); // Save changes made in the modal
            },
        );
        modal.open();
    }
}

// --- Modal Helper Class for Frontmatter Field Selection ---
// (Can stay here or be moved to ui/modals)
class FrontmatterFieldModal extends Modal {
    private currentSettings: FrontmatterSettings;
    private fieldStates: Record<string, boolean>; // id -> isDisabled

    constructor(
        app: App,
        initialSettings: FrontmatterSettings,
        private options: Array<{ id: string; name: string }>,
        private onSave: (newSettings: FrontmatterSettings) => void,
    ) {
        super(app);
        // Clone settings to avoid modifying original object until save
        this.currentSettings = {
            disabledFields: [...(initialSettings.disabledFields || [])],
            customFields: [...(initialSettings.customFields || [])], // Keep custom fields config here too
        };
        // Initialize temporary state for toggles
        this.fieldStates = {};
        for (const field of this.options) {
            this.fieldStates[field.id] = this.currentSettings.disabledFields
                .includes(field.id);
        }
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("koreader-frontmatter-modal");

        contentEl.createEl("h3", {
            text: "Manage Excluded Frontmatter Fields",
        });
        contentEl.createEl("p", {
            text: "Check a field to EXCLUDE it from generated frontmatter.",
        });

        const listEl = contentEl.createDiv("frontmatter-field-list");

        // Create toggles for standard fields
        for (const field of this.options) {
            new Setting(listEl)
                .setName(field.name)
                .addToggle((toggle) =>
                    toggle
                        .setValue(this.fieldStates[field.id])
                        .onChange((isDisabled) => {
                            this.fieldStates[field.id] = isDisabled;
                        })
                );
        }

        contentEl.createEl("h3", { text: "Custom Fields" });
        contentEl.createEl("p", {
            text:
                "Add extra fields from KoReader metadata (comma-separated). These will be included unless also excluded above.",
        });

        new Setting(contentEl)
            // .setName("Custom fields to include")
            .addTextArea((text) =>
                text
                    .setValue(this.currentSettings.customFields.join(", "))
                    .setPlaceholder("e.g., publisher, isbn")
                    .onChange((value) => {
                        this.currentSettings.customFields = value.split(",")
                            .map((f) => f.trim()).filter(Boolean);
                    })
            );

        // Save and Cancel buttons
        new Setting(contentEl)
            .addButton((button) =>
                button.setButtonText("Save")
                    .setCta()
                    .onClick(() => {
                        // Update disabledFields based on toggle states
                        this.currentSettings.disabledFields = Object.entries(
                            this.fieldStates,
                        )
                            .filter(([_, isDisabled]) => isDisabled)
                            .map(([id, _]) => id);

                        this.onSave(this.currentSettings); // Pass updated settings back
                        this.close();
                    })
            )
            .addButton((button) =>
                button.setButtonText("Cancel")
                    .onClick(() => this.close())
            );
    }

    onClose() {
        this.contentEl.empty();
    }
}
