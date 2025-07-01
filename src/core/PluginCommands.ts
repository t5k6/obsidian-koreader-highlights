import { type Plugin } from "obsidian";
import type { ImportManager } from "../services/ImportManager";
import type { ScanManager } from "../services/ScanManager";
import { runPluginAction } from "../utils/actionUtils";

export class PluginCommands {
    constructor(
        private plugin: Plugin,
        private importManager: ImportManager,
        private scanManager: ScanManager,
    ) {}

    public registerCommands(): void {
        this.plugin.addCommand({
            id: "import-koreader-highlights",
            name: "Import KOReader Highlights",
            callback: () => this.handleImportCommand(),
        });

        this.plugin.addCommand({
            id: "scan-koreader-highlights",
            name: "Scan KOReader for Highlights",
            callback: () => this.handleScanCommand(),
        });
    }

    public async handleImportCommand(): Promise<void> {
        await runPluginAction(() => this.importManager.importHighlights(), {
            failureNotice: "Failed to import highlights",
        });
    }

    public async handleScanCommand(): Promise<void> {
        await runPluginAction(() => this.scanManager.scanForHighlights(), {
            failureNotice: "Failed to scan for highlights",
        });
    }
}
