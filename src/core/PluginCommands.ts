import { Notice, type Plugin } from "obsidian";
import type { ImportManager } from "../services/ImportManager";
import type { ScanManager } from "../services/ScanManager";
import { devError } from "../utils/logging";

export class PluginCommands {
    constructor(
        private plugin: Plugin,
        private importManager: ImportManager,
        private scanManager: ScanManager,
    ) {}

    public registerCommands(): void {
        this.plugin.addCommand({
            id: "import-koreader-highlights",
            name: "Import KoReader Highlights",
            callback: () => this.handleImportCommand(),
        });

        this.plugin.addCommand({
            id: "scan-koreader-highlights",
            name: "Scan KoReader for Highlights",
            callback: () => this.handleScanCommand(),
        });
    }

    private async handleImportCommand(): Promise<void> {
        try {
            await this.importManager.importHighlights();
        } catch (error) {
            devError(
                'Error executing "Import KoReader Highlights" command:',
                error,
            );
            new Notice(
                "KOReader Importer: Failed to import highlights. Check console for details.",
            );
        }
    }

    private async handleScanCommand(): Promise<void> {
        try {
            await this.scanManager.scanForHighlights();
        } catch (error) {
            devError(
                'Error executing "Scan KoReader for Highlights" command:',
                error,
            );
            new Notice(
                "KOReader Importer: Failed to scan for highlights. Check console for details.",
            );
        }
    }
}
