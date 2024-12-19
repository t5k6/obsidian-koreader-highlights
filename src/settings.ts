import {
    type App,
    normalizePath,
    Notice,
    PluginSettingTab,
    Setting,
    SuggestModal,
    TFolder,
} from "obsidian";
import type KoReaderHighlightImporter from "./main";
import { setDebugMode } from "./utils";

// Helper function to get all folders
function getAllFolders(app: App): string[] {
    const folders: string[] = [];
    const rootFolder = app.vault.getRoot();

    function traverseFolder(folder: TFolder) {
        folders.push(folder.path);
        for (const child of folder.children) {
            if (child instanceof TFolder) {
                traverseFolder(child);
            }
        }
    }

    traverseFolder(rootFolder);
    return folders;
}

// Suggest Modal for selecting folders
class FolderSuggestModal extends SuggestModal<string> {
    onSubmit: (result: string) => void;

    constructor(app: App, onSubmit: (result: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
    }

    getSuggestions(query: string): string[] {
        const folders = getAllFolders(this.app);
        const lowerCaseQuery = query.toLowerCase();
        return folders.filter((folder) =>
            folder.toLowerCase().includes(lowerCaseQuery)
        );
    }

    renderSuggestion(value: string, el: HTMLElement) {
        el.createEl("div", { text: value });
    }

    onChooseSuggestion(item: string, evt: MouseEvent | KeyboardEvent) {
        this.onSubmit(item);
    }

    onNoSuggestion() {
        // Display the current input value as a suggestion to create a new folder
        const query = this.inputEl.value;
        if (query) {
            this.resultContainerEl.empty();
            const suggestionEl = this.resultContainerEl.createEl("div", {
                cls: "suggestion-item",
            });
            suggestionEl.createEl("div", {
                text: `Create new folder: "${query}"`,
            });
            suggestionEl.addEventListener("click", () => {
                this.onSubmit(query);
                this.close();
            });
        }
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
        containerEl.createEl("h3", { text: "Core Settings" });

        new Setting(containerEl)
            .setName("KoReader Mount Point")
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

        new Setting(containerEl)
            .setName("Highlights Folder")
            .setDesc(
                "Specify the directory where you would like to save your highlights.",
            )
            .addText((text) => {
                text
                    .setPlaceholder("/KoReader Highlights/")
                    .setValue(this.plugin.settings.highlightsFolder)
                    .onChange(() => {
                        new FolderSuggestModal(this.app, async (result) => {
                            try {
                                const normalizedResult = normalizePath(result);
                                // Create the folder if it doesn't exist
                                if (
                                    !(this.app.vault.getAbstractFileByPath(
                                        normalizedResult,
                                    ) instanceof TFolder)
                                ) {
                                    await this.app.vault.createFolder(
                                        normalizedResult,
                                    );
                                }
                                text.setValue(normalizedResult);
                                this.plugin.settings.highlightsFolder =
                                    normalizedResult;
                                await this.plugin.saveSettings();
                            } catch (error) {
                                new Notice(
                                    `KOReader Importer: Failed to create folder: ${result}`,
                                );
                            }
                        }).open();
                    });
            });

        // --- Filtering/Exclusion Settings ---
        containerEl.createEl("h3", { text: "Filtering/Exclusion Settings" });

        new Setting(containerEl)
            .setName("Excluded Folders")
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
            .setName("Allowed File Types")
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
        containerEl.createEl("h3", { text: "Actions" });

        new Setting(containerEl)
            .setName("Scan for SDR Files")
            .setDesc(
                "Click to scan the KoReader mount point for highlight files.",
            )
            .addButton((button) =>
                button.setButtonText("Scan for Annotations").onClick(() => {
                    this.plugin.scanHighlightsDirectory();
                })
            );

        new Setting(containerEl)
            .setName("Import Highlights")
            .setDesc(
                "Click to import highlights from the KoReader mount point.",
            )
            .addButton((button) =>
                button.setButtonText("Import Annotations").onClick(() => {
                    this.plugin.importHighlights();
                })
            );

        // --- Advanced/Troubleshooting ---
        containerEl.createEl("h3", { text: "Advanced/Troubleshooting" });

        new Setting(containerEl)
            .setName("Debug Mode")
            .setDesc("Enable debug logging for troubleshooting.")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.debugMode)
                    .onChange(async (value) => {
                        this.plugin.settings.debugMode = value;
                        setDebugMode(value);
                        await this.plugin.saveSettings();
                    })
            );
    }
}
