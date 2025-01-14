import {
    AbstractInputSuggest,
    type App,
    normalizePath,
    Notice,
    PluginSettingTab,
    Setting,
    TFolder,
} from "obsidian";
import type KoReaderHighlightImporter from "./main";
import { setDebugMode } from "./utils";

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

    renderSuggestion(folderPath: string, el: HTMLElement) {
        el.createEl("div", { text: folderPath });
    }

    async onChooseSuggestion(
        item: string,
        evt: MouseEvent | KeyboardEvent,
    ): Promise<void> {
        this.inputEl.value = item;
        this.onSubmit(item);
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

        new Setting(containerEl)
            .setName("Highlights folder")
            .setDesc(
                "Specify the directory where you would like to save your highlights.",
            )
            .addText((text) => {
                text
                    .setPlaceholder("/KoReader Highlights/")
                    .setValue(this.plugin.settings.highlightsFolder)
                    .onChange(async (value) => {
                        try {
                            const normalizedResult = normalizePath(value);

                            // Create the folder if it doesn't exist
                            const folder = this.app.vault.getAbstractFileByPath(
                                normalizedResult,
                            );
                            if (!folder || !(folder instanceof TFolder)) {
                                await this.app.vault.createFolder(
                                    normalizedResult,
                                );
                            }
                            this.plugin.settings.highlightsFolder =
                                normalizedResult;
                            await this.plugin.saveSettings();
                        } catch (error) {
                            new Notice(
                                `KOReader Importer: Failed to create folder: ${value}`,
                            );
                        }
                    });
                new FolderInputSuggest(
                    this.app,
                    text.inputEl,
                    (result) => {
                        text.setValue(result);
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
            .setName("Debug mode")
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
