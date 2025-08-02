import { Notice, Plugin } from "obsidian";
import { DEFAULT_LOGS_FOLDER } from "src/constants";
import { CommandManager } from "src/services/command/CommandManager";
import { DatabaseService } from "src/services/DatabaseService";
import { SDRFinder } from "src/services/device/SDRFinder";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { SettingsTab } from "src/ui/SettingsTab";
import { logger } from "src/utils/logging";
import type {
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "../types";
import { DIContainer } from "./DIContainer";
import { MigrationManager } from "./MigrationManager";
import { PluginSettings } from "./PluginSettings";
import { registerServices } from "./registerServices";
import { APP_TOKEN, PLUGIN_TOKEN, VAULT_TOKEN } from "./tokens";

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

		this.plugin.addCommand({
			id: "convert-comment-style",
			name: "Convert All Files to Current Comment Style",
			callback: () => this.plugin.triggerConvertCommentStyle(),
		});
	}
}

export default class KoreaderImporterPlugin extends Plugin {
	public settings!: KoreaderHighlightImporterSettings;
	public settingTab!: SettingsTab;
	private pluginSettings!: PluginSettings;
	private diContainer = new DIContainer();
	private servicesInitialized = false;
	private migrationManager!: MigrationManager;
	public templateManager!: TemplateManager;

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
		logger.setLevel(this.settings.logLevel);
		logger.enableFileSink(
			this.settings.logToFile,
			this.app.vault,
			this.settings.logsFolder || DEFAULT_LOGS_FOLDER,
		);

		try {
			// Register all services with the DI container
			registerServices(this.diContainer, this, this.app);

			// Resolve services needed by the plugin itself
			this.templateManager =
				this.diContainer.resolve<TemplateManager>(TemplateManager);
			await this.templateManager.loadBuiltInTemplates();
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

		await this.diContainer.dispose();
		await logger.dispose();

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

	// --- Methods Called by UI Elements ---
	async triggerImport(): Promise<void> {
		if (!this.checkServiceStatus("import")) return;
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		await commandManager.executeImport();
	}

	async triggerScan(): Promise<void> {
		if (!this.checkServiceStatus("scan")) return;
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		await commandManager.executeScan();
	}

	async triggerClearCaches(): Promise<void> {
		if (!this.checkServiceStatus("cache clearing")) return;
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		await commandManager.executeClearCaches();
	}

	async triggerConvertCommentStyle(): Promise<void> {
		if (!this.checkServiceStatus("comment style conversion")) return;
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		await commandManager.executeConvertCommentStyle();
	}

	async saveSettings(forceUpdate: boolean = false): Promise<void> {
		if (!this.pluginSettings) {
			logger.error(
				"KOReaderImporterPlugin: Cannot save settings: PluginSettings helper not initialized.",
			);
			return;
		}

		const oldSettings = { ...this.settings };
		await this.pluginSettings.saveSettings(this.settings);

		// Update logger immediately
		logger.setLevel(this.settings.logLevel);
		logger.enableFileSink(
			this.settings.logToFile,
			this.app.vault,
			this.settings.logsFolder || DEFAULT_LOGS_FOLDER,
		);

		// Notify all registered observer services of the change
		this.diContainer.notifySettingsChanged(this.settings, oldSettings);

		if (forceUpdate) {
			// Re-render the entire settings tab to show/hide dependent settings
			this.settingTab.display();
		}

		logger.info(
			"KOReaderImporterPlugin: Settings saved. Services notified of changes.",
		);
	}
}
