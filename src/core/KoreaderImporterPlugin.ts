import { Notice, Plugin } from "obsidian";
import { registerServices } from "src/core/registerServices";
import { DatabaseService } from "src/services/DatabaseService";
import type { ImportManager } from "src/services/ImportManager";
import { MountPointService } from "src/services/MountPointService";
import type { ScanManager } from "src/services/ScanManager";
import { SDRFinder } from "src/services/SDRFinder";
import { TemplateManager } from "src/services/TemplateManager";
import { SettingsTab } from "src/ui/SettingsTab";
import { runPluginAction } from "src/utils/actionUtils";
import { logger } from "src/utils/logging";
import type { KoreaderHighlightImporterSettings } from "../types";
import { DIContainer } from "./DIContainer";
import { MigrationManager } from "./MigrationManager";
import { PluginSettings } from "./PluginSettings";

export class PluginCommands {
	constructor(private plugin: KoreaderImporterPlugin) {}

	public registerCommands(): void {
		this.plugin.addCommand({
			id: "import-koreader-highlights",
			name: "Import KOReader Highlights",
			callback: () => this.plugin.triggerImport(),
		});

		this.plugin.addCommand({
			id: "scan-koreader-highlights",
			name: "Scan KOReader for Highlights",
			callback: () => this.plugin.triggerScan(),
		});
	}
}

export default class KoreaderImporterPlugin extends Plugin {
	public settings!: KoreaderHighlightImporterSettings;
	public settingTab!: SettingsTab;
	private pluginSettings!: PluginSettings;
	private diContainer = new DIContainer();
	private servicesInitialized = false;
	private importManager!: ImportManager;
	private scanManager!: ScanManager;
	private migrationManager!: MigrationManager;
	public templateManager!: TemplateManager;
	private mountPointService!: MountPointService;

	async onload() {
		console.log("KOReaderImporterPlugin: Loading...");
		this.servicesInitialized = false;

		// Load Settings
		try {
			this.pluginSettings = new PluginSettings(this);
			this.settings = await this.pluginSettings.loadSettings();
		} catch (error) {
			console.error(
				"KOReaderImporterPlugin: CRITICAL ERROR loading settings:",
				error,
			);
			new Notice(
				"Failed to load KOReader Importer settings. Plugin disabled.",
				0,
			);
			return;
		}

		// Initialize Logging
		logger.setLevel(this.settings.debugLevel);
		logger.enableFileSink(
			this.settings.debugMode,
			this.app.vault,
			"KOReader/logs",
		);

		try {
			// Initialize Services
			const { importManager, scanManager } = registerServices(
				this.diContainer,
				this,
				this.app,
			);

			// Assign the core services returned by the registration function
			this.importManager = importManager;
			this.scanManager = scanManager;

			this.templateManager =
				this.diContainer.resolve<TemplateManager>(TemplateManager);
			await this.templateManager.loadBuiltInTemplates();
			this.mountPointService =
				this.diContainer.resolve<MountPointService>(MountPointService);
			this.migrationManager = new MigrationManager(this);

			this.servicesInitialized = true;
			logger.info(
				"KOReaderImporterPlugin: All services initialized successfully.",
			);

			// Run migrations in the background so we don't block Obsidian load
			setTimeout(
				() =>
					this.migrationManager
						.run()
						.catch((e) =>
							logger.error("KOReaderImporterPlugin: Migration failed", e),
						),
				0,
			);
		} catch (error) {
			this.servicesInitialized = false;
			logger.error(
				"KOReaderImporterPlugin: CRITICAL error initializing services:",
				error,
			);
			new Notice(
				"Error initializing KOReader Importer services. Plugin functionality may be limited. Please check settings or reload.",
				15000,
			);
		}

		// Register Commands
		if (this.servicesInitialized) {
			const pluginCommands = new PluginCommands(this);
			pluginCommands.registerCommands();
		} else {
			logger.warn(
				"KOReaderImporterPlugin: Skipping command registration due to service initialization failure.",
			);
		}

		// Add Settings Tab
		this.settingTab = new SettingsTab(this.app, this);
		this.addSettingTab(this.settingTab);
		logger.info("KOReaderImporterPlugin: Settings tab added.");

		// Ensure Templates
		try {
			const templateManager =
				this.diContainer.resolve<TemplateManager>(TemplateManager);
			await templateManager.ensureTemplates();
			logger.info("KOReaderImporterPlugin: Default templates ensured.");
		} catch (error) {
			logger.error(
				"KoreaderImporterPlugin: Failed to ensure default templates:",
				error,
			);
			new Notice("Could not create default KOReader templates.");
		}

		console.log("KOReaderImporterPlugin: Loaded successfully.");
	}

	async onunload() {
		console.log("KOReaderImporterPlugin: Unloading...");

		await logger.dispose(); // Flush & close file sink before DI disposal
		await this.diContainer.dispose();

		this.servicesInitialized = false;
	}

	// --- Utility Methods ---
	private checkServiceStatus(operation: string): boolean {
		if (!this.servicesInitialized) {
			logger.error(
				`KOReaderImporterPlugin: Cannot trigger ${operation}: Services not fully initialized.`,
			);
			new Notice(
				"Error: KOReader Importer services not ready. Please check settings or reload the plugin.",
				7000,
			);
			return false;
		}
		return true;
	}

	// --- Methods Called by SettingsTab ---
	async triggerImport(): Promise<void> {
		logger.info("KOReaderImporterPlugin: Import triggered.");
		if (!this.checkServiceStatus("import")) return;
		if (!(await this.mountPointService.ensureMountPoint())) {
			new Notice(
				"KOReader device not found. Please check the mount point in settings.",
			);
			return;
		}

		await runPluginAction(() => this.importManager.importHighlights(), {
			failureNotice: "An unexpected error occurred during import",
		}).catch((error) => {
			if (error.name !== "AbortError") {
				logger.error(
					"KOReader Importer Plugin: Import failed with an unexpected error",
					error,
				);
				new Notice("Import failed. Check console for details.");
			}
			// If it is an AbortError, it's already handled by the modal, so we do nothing.
		});
	}

	async triggerScan(): Promise<void> {
		logger.info("KOReaderImporterPlugin: Scan triggered.");
		if (!this.checkServiceStatus("scan")) return;
		if (!(await this.mountPointService.ensureMountPoint())) return;

		await runPluginAction(() => this.scanManager.scanForHighlights(), {
			failureNotice: "An unexpected error occurred during scan",
		});
	}

	async clearCaches(): Promise<void> {
		logger.info(
			"KOReaderImporterPlugin: Cache clear triggered from settings tab.",
		);
		if (!this.checkServiceStatus("cache clearing")) return;

		await runPluginAction(() => this.importManager.clearCaches(), {
			failureNotice: "Failed to clear caches",
		});
	}

	async saveSettings(): Promise<void> {
		if (!this.pluginSettings) {
			logger.error(
				"KOReaderImporterPlugin: Cannot save settings: PluginSettings helper not initialized.",
			);
			return;
		}

		const currentSettings = this.settings;
		await this.pluginSettings.saveSettings(this.settings);

		logger.setLevel(currentSettings.debugLevel);
		logger.enableFileSink(currentSettings.debugMode, this.app.vault);

		try {
			this.diContainer.resolve<SDRFinder>(SDRFinder).updateSettings();
			this.diContainer
				.resolve<DatabaseService>(DatabaseService)
				.setSettings(this.settings);
			this.templateManager.updateSettings(this.settings);
		} catch (error) {
			logger.error(
				"KOReaderImporterPlugin: Failed to update settings in one or more services",
				error,
			);
		}

		logger.info(
			"KOReaderImporterPlugin: Settings saved. Services notified of potential changes.",
		);
	}
}
