import { type App, Notice, Plugin } from "obsidian";
import { ContentGenerator } from "../services/ContentGenerator";
import { DatabaseService } from "../services/DatabaseService";
import { DuplicateHandler } from "../services/DuplicateHandler";
import { FrontmatterGenerator } from "../services/FrontmatterGenerator";
import { ImportManager } from "../services/ImportManager";
import { MetadataParser } from "../services/MetadataParser";
import { SDRFinder } from "../services/SDRFinder";
import { ScanManager } from "../services/ScanManager";
import { TemplateManager } from "../services/TemplateManager";
import type {
    DuplicateMatch,
    IDuplicateHandlingModal,
    KoReaderHighlightImporterSettings,
} from "../types";
import { DuplicateHandlingModal } from "../ui/DuplicateModal";
import { SettingsTab } from "../ui/SettingsTab";
import {
    closeLogging,
    devError,
    devLog,
    devWarn,
    initLogging,
    setDebugLevel,
    setDebugMode,
} from "../utils/logging";
import { PluginCommands } from "./PluginCommands";
import { PluginSettings } from "./PluginSettings";

export default class KoReaderImporterPlugin extends Plugin {
    public settings!: KoReaderHighlightImporterSettings;
    private pluginSettings!: PluginSettings;

    private sdrFinder!: SDRFinder;
    private databaseService!: DatabaseService;
    private metadataParser!: MetadataParser;
    private templateManager!: TemplateManager;
    private frontmatterGenerator!: FrontmatterGenerator;
    private contentGenerator!: ContentGenerator;
    private duplicateHandler!: DuplicateHandler;
    private importManager!: ImportManager;
    private scanManager!: ScanManager;

    private servicesInitialized = false;

    async onload() {
        console.log("KoReader Importer Plugin: Loading...");
        this.servicesInitialized = false;

        // Load Settings
        try {
            this.pluginSettings = new PluginSettings(this);
            this.settings = await this.pluginSettings.loadSettings();
        } catch (error) {
            console.error(
                "KoReader Importer: CRITICAL ERROR loading settings:",
                error,
            );
            new Notice(
                "Failed to load KoReader Importer settings. Plugin disabled.",
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
                    "KoReader/logs",
                    cleanupOptions,
                );
                devLog("File logging initialized:", logFilePath);
            } catch (error) {
                console.error(
                    "KoReader Importer: Failed to initialize file logging:",
                    error,
                );
                new Notice("Failed to initialize KoReader Importer log file.");
            }
        }

        devLog(
            "KoReader Importer: Settings loaded, proceeding with service initialization.",
        );

        // Initialize Services
        try {
            this.sdrFinder = new SDRFinder(this.settings);
            this.databaseService = new DatabaseService(this.settings);
            this.templateManager = new TemplateManager(
                this.app.vault,
                this.settings,
            );
            this.frontmatterGenerator = new FrontmatterGenerator();
            this.metadataParser = new MetadataParser(
                this.settings,
                this.sdrFinder,
            );
            this.contentGenerator = new ContentGenerator(
                this.templateManager,
                this.settings,
            );
            const modalFactory = (
                app: App,
                match: DuplicateMatch,
                message: string,
            ): IDuplicateHandlingModal => {
                return new DuplicateHandlingModal(app, match, message);
            };
            this.duplicateHandler = new DuplicateHandler(
                this.app.vault,
                this.app,
                modalFactory,
                this.settings,
                this.frontmatterGenerator,
            );

            this.importManager = new ImportManager(
                this.app,
                this.settings,
                this.sdrFinder,
                this.metadataParser,
                this.databaseService,
                this.frontmatterGenerator,
                this.contentGenerator,
                this.duplicateHandler,
            );
            this.scanManager = new ScanManager(
                this.app,
                this.settings,
                this.sdrFinder,
            );

            this.servicesInitialized = true;
            devLog("All services initialized successfully.");
        } catch (error) {
            this.servicesInitialized = false;
            devError(
                "CRITICAL error initializing KoReader Importer services:",
                error,
            );
            new Notice(
                "Error initializing KoReader Importer services. Plugin functionality may be limited. Please check settings or reload.",
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
            await this.templateManager.ensureTemplates();
            devLog("Default templates ensured.");
        } catch (error) {
            devError("Failed to ensure default templates:", error);
            new Notice("Could not create default KoReader templates.");
        }

        console.log("KoReader Importer Plugin: Loaded successfully.");
    }

    onunload() {
        console.log("KoReader Importer Plugin: Unloading...");
        this.databaseService?.closeDatabase();
        closeLogging();
        this.servicesInitialized = false;
        devLog("KoReader Importer resources cleaned up.");
    }

    // --- Utility Methods ---
    private checkServiceStatus(operation: string): boolean {
        if (
            !this.servicesInitialized || !this.importManager ||
            !this.scanManager
        ) {
            devError(
                `Cannot trigger ${operation}: Services not fully initialized.`,
            );
            new Notice(
                "Error: KoReader Importer services not ready. Please check settings or reload the plugin.",
                7000,
            );
            return false;
        }
        return true;
    }

    // --- Methods Called by SettingsTab ---
    async triggerImport(): Promise<void> {
        devLog("Import triggered from settings tab.");
        if (!this.checkServiceStatus("import")) return;

        try {
            await this.importManager.importHighlights();
        } catch (error) {
            devError("Unhandled error during triggered import:", error);
            new Notice(
                "An unexpected error occurred during import. Check console.",
                5000,
            );
        }
    }

    async triggerScan(): Promise<void> {
        devLog("Scan triggered from settings tab.");
        if (!this.checkServiceStatus("scan")) return;

        try {
            await this.scanManager.scanForHighlights();
        } catch (error) {
            devError("Unhandled error during triggered scan:", error);
            new Notice(
                "An unexpected error occurred during scan. Check console.",
                5000,
            );
        }
    }

    async clearCaches(): Promise<void> {
        devLog("Cache clear triggered from settings tab.");
        if (!this.checkServiceStatus("cache clearing")) return;

        try {
            await this.importManager.clearCaches();
            new Notice("KoReader Importer caches cleared.");
        } catch (error) {
            devError("Error clearing caches:", error);
            new Notice(
                "Failed to clear caches. See console for details.",
                5000,
            );
        }
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

        this.sdrFinder?.updateSettings(currentSettings);
        this.databaseService?.updateSettings(currentSettings);
        this.templateManager?.updateSettings(currentSettings);

        devLog("Settings saved. Services notified of potential changes.");
    }
}
