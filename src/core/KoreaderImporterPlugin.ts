import { Notice, Plugin } from "obsidian";
import { DatabaseService } from "../services/DatabaseService";
import { ImportManager } from "../services/ImportManager";
import { SDRFinder } from "../services/SDRFinder";
import { ScanManager } from "../services/ScanManager";
import { TemplateManager } from "../services/TemplateManager";
import type { KoreaderHighlightImporterSettings } from "../types";
import { SettingsTab } from "../ui/SettingsTab";
import { runPluginAction } from "../utils/actionUtils";
import {
    closeLogging,
    devError,
    devLog,
    devWarn,
    initLogging,
    setDebugLevel,
    setDebugMode,
} from "../utils/logging";
import { DIContainer } from "./DIContainer";
import { PluginCommands } from "./PluginCommands";
import { PluginSettings } from "./PluginSettings";
import { ServiceInitializer } from "./ServiceInitializer";

export default class KoreaderImporterPlugin extends Plugin {
    public settings!: KoreaderHighlightImporterSettings;
    private pluginSettings!: PluginSettings;
    private diContainer = new DIContainer();
    private servicesInitialized = false;
    private importManager!: ImportManager;
    private scanManager!: ScanManager;

    async onload() {
        console.log("KOReader Importer Plugin: Loading...");
        this.servicesInitialized = false;

        // Load Settings
        try {
            this.pluginSettings = new PluginSettings(this);
            this.settings = await this.pluginSettings.loadSettings();
        } catch (error) {
            console.error(
                "KOReader Importer: CRITICAL ERROR loading settings:",
                error,
            );
            new Notice(
                "Failed to load KOReader Importer settings. Plugin disabled.",
                0,
            );
            return;
        }

        // Initialize Logging
        setDebugMode(this.settings.debugMode);
        setDebugLevel(this.settings.debugLevel);

        if (this.settings.debugMode) {
            try {
                const cleanupOptions = { enabled: true, maxAgeDays: 7 };
                const logFilePath = await initLogging(
                    this.app.vault,
                    "KOReader/logs",
                    cleanupOptions,
                );
                devLog("File logging initialized:", logFilePath);
            } catch (error) {
                console.error(
                    "KOReader Importer: Failed to initialize file logging:",
                    error,
                );
                new Notice("Failed to initialize KOReader Importer log file.");
            }
        }

        devLog(
            "KOReader Importer: Settings loaded, proceeding with service initialization.",
        );

        // Initialize Services
        try {
            ServiceInitializer.init(
                this.diContainer,
                this,
                this.app,
                this.settings,
            );

            this.importManager =
                this.diContainer.resolve<ImportManager>(ImportManager);
            this.scanManager =
                this.diContainer.resolve<ScanManager>(ScanManager);

            this.servicesInitialized = true;
            devLog("All services initialized successfully.");
        } catch (error) {
            this.servicesInitialized = false;
            devError(
                "CRITICAL error initializing KOReader Importer services:",
                error,
            );
            new Notice(
                "Error initializing KOReader Importer services. Plugin functionality may be limited. Please check settings or reload.",
                15000,
            );
        }

        // Register Commands
        if (this.servicesInitialized) {
            const pluginCommands = new PluginCommands(
                this,
                this.importManager,
                this.scanManager,
            );
            pluginCommands.registerCommands();
        } else {
            devWarn(
                "Skipping command registration due to service initialization failure.",
            );
        }

        // Add Settings Tab
        this.addSettingTab(new SettingsTab(this.app, this));
        devLog("Settings tab added.");

        // Ensure Templates
        try {
            const templateManager =
                this.diContainer.resolve<TemplateManager>(TemplateManager);
            await templateManager.ensureTemplates();
            devLog("Default templates ensured.");
        } catch (error) {
            devError("Failed to ensure default templates:", error);
            new Notice("Could not create default KOReader templates.");
        }

        console.log("KOReader Importer Plugin: Loaded successfully.");
    }

    onunload() {
        console.log("KOReader Importer Plugin: Unloading...");

        try {
            const dbService =
                this.diContainer.resolve<DatabaseService>(DatabaseService);
            dbService.closeDatabase();
        } catch (error) {
            devWarn(
                "DatabaseService not found during unload, may have failed to initialize.",
            );
        }

        closeLogging();
        this.servicesInitialized = false;
        devLog("KOReader Importer resources cleaned up.");
    }

    // --- Utility Methods ---
    private checkServiceStatus(operation: string): boolean {
        if (
            !this.servicesInitialized ||
            !this.importManager ||
            !this.scanManager
        ) {
            devError(
                `Cannot trigger ${operation}: Services not fully initialized.`,
            );
            new Notice(
                "Error: KOReader Importer services not ready. Please check settings or reload the plugin.",
                7000,
            );
            return false;
        }
        return true;
    }

    private async ensureValidMountPoint(): Promise<boolean> {
        const sdrFinder = this.diContainer.resolve<SDRFinder>(SDRFinder);
        const ok = await sdrFinder.checkMountPoint();
        if (!ok) {
            new Notice(
                "Mount point is not valid or accessible. Please check settings.",
            );
            devError("Operation aborted: Invalid mount point.");
        }
        return ok;
    }

    // --- Methods Called by SettingsTab ---
    async triggerImport(): Promise<void> {
        devLog("Import triggered from settings tab.");
        if (!this.checkServiceStatus("import")) return;
        if (!(await this.ensureValidMountPoint())) return;

        await runPluginAction(() => this.importManager.importHighlights(), {
            failureNotice: "An unexpected error occurred during import",
        });
    }

    async triggerScan(): Promise<void> {
        devLog("Scan triggered from settings tab.");
        if (!this.checkServiceStatus("scan")) return;
        if (!(await this.ensureValidMountPoint())) return;

        await runPluginAction(() => this.scanManager.scanForHighlights(), {
            failureNotice: "An unexpected error occurred during scan",
        });
    }

    async clearCaches(): Promise<void> {
        devLog("Cache clear triggered from settings tab.");
        if (!this.checkServiceStatus("cache clearing")) return;

        await runPluginAction(() => this.importManager.clearCaches(), {
            failureNotice: "Failed to clear caches",
        });
    }

    async saveSettings(): Promise<void> {
        if (!this.pluginSettings) {
            devError(
                "Cannot save settings: PluginSettings helper not initialized.",
            );
            return;
        }

        const currentSettings = this.settings;
        await this.pluginSettings.saveSettings(currentSettings);

        setDebugLevel(currentSettings.debugLevel);

        try {
            this.diContainer
                .resolve<SDRFinder>(SDRFinder)
                .updateSettings(currentSettings);
            this.diContainer
                .resolve<DatabaseService>(DatabaseService)
                .setSettings(currentSettings);
            this.diContainer
                .resolve<TemplateManager>(TemplateManager)
                .updateSettings(currentSettings);
        } catch (error) {
            devError(
                "Failed to update settings in one or more services",
                error,
            );
        }

        devLog("Settings saved. Services notified of potential changes.");
    }
}
