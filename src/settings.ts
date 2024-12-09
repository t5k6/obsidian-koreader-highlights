import { type App, PluginSettingTab, Setting } from "obsidian";
import type KoReaderHighlightImporter from "./main";

export class KoReaderSettingTab extends PluginSettingTab {
    plugin: KoReaderHighlightImporter;

    constructor(app: App, plugin: KoReaderHighlightImporter) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

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
                        this.plugin.settings.koboMountPoint = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Highlights Folder")
            .setDesc(
                "Specify the directory where you would like to save your highlights.",
            )
            .addText((text) =>
                text
                    .setPlaceholder("/KoReader Highlights/")
                    .setValue(this.plugin.settings.highlightsFolder)
                    .onChange(async (value: string) => {
                        this.plugin.settings.highlightsFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

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
    }
}
