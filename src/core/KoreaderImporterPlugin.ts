import { Notice, Plugin } from "obsidian";
import { CommandManager } from "src/services/command/CommandManager";
import { LoggingService } from "src/services/LoggingService";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { SettingsTab } from "src/ui/SettingsTab";
import type { KoreaderHighlightImporterSettings } from "../types";
import { DIContainer } from "./DIContainer";
import { MigrationManager } from "./MigrationManager";
import { PluginSettings } from "./PluginSettings";
import { registerServices } from "./registerServices";

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
	private loggingService!: LoggingService;
	private diContainer!: DIContainer;
	private servicesInitialized = false;
	private migrationManager!: MigrationManager;
	public templateManager!: TemplateManager;

	async onload() {
		console.log("KOReaderImporterPlugin: Loading...");
		this.servicesInitialized = false;

		// --- Bootstrap Sequence ---
		// 1. Load settings data without dependencies
		this.pluginSettings = new PluginSettings(this);
		try {
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

		// 2. Create LoggingService
		this.loggingService = new LoggingService(this.app.vault);

		// 3. Manually configure the logger for the first time with loaded settings
		this.loggingService.onSettingsChanged(this.settings);

		// 4. Create the DI Container and register the logger instance
		this.diContainer = new DIContainer(this.loggingService);
		this.diContainer.registerValue(LoggingService, this.loggingService);

		// 5. Initialize the rest of the services
		try {
			registerServices(this.diContainer, this, this.app);

			this.templateManager =
				this.diContainer.resolve<TemplateManager>(TemplateManager);
			await this.templateManager.loadBuiltInTemplates();
			this.migrationManager = new MigrationManager(this, this.loggingService);

			this.servicesInitialized = true;
			this.loggingService.info(
				"KoreaderImporterPlugin",
				"All services initialized successfully.",
			);

			setTimeout(
				() =>
					this.migrationManager
						.run()
						.catch((e) =>
							this.loggingService.error(
								"KoreaderImporterPlugin",
								"Migration failed",
								e,
							),
						),
				0,
			);
		} catch (error) {
			this.servicesInitialized = false;
			this.loggingService.error(
				"KoreaderImporterPlugin",
				"CRITICAL error initializing services:",
				error,
			);
			new Notice(
				"Error initializing KOReader Importer services. Plugin functionality may be limited. Please check settings or reload.",
				1500,
			);
		}

		if (this.servicesInitialized) {
			const pluginCommands = new PluginCommands(this);
			pluginCommands.registerCommands();
		} else {
			this.loggingService.warn(
				"KoreaderImporterPlugin",
				"Skipping command registration due to service initialization failure.",
			);
		}

		this.addSettingTab(new SettingsTab(this.app, this));
		this.loggingService.info("KoreaderImporterPlugin", "Settings tab added.");

		try {
			const templateManager =
				this.diContainer.resolve<TemplateManager>(TemplateManager);
			await templateManager.ensureTemplates();
			this.loggingService.info(
				"KoreaderImporterPlugin",
				"Default templates ensured.",
			);
		} catch (error) {
			this.loggingService.error(
				"KoreaderImporterPlugin",
				"Failed to ensure default templates:",
				error,
			);
			new Notice("Could not create default KOReader templates.");
		}

		console.log("KOReaderImporterPlugin: Loaded successfully.");
	}

	async onunload() {
		console.log("KOReaderImporterPlugin: Unloading...");

		if (this.diContainer) {
			await this.diContainer.dispose();
		}

		if (this.loggingService) {
			await this.loggingService.dispose();
		}

		this.servicesInitialized = false;
	}

	// --- Utility Methods ---
	private checkServiceStatus(operation: string): boolean {
		if (!this.servicesInitialized) {
			this.loggingService.error(
				"KoreaderImporterPlugin",
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
			this.loggingService.error(
				"KoreaderImporterPlugin",
				"Cannot save settings: PluginSettings helper not initialized.",
			);
			return;
		}

		const oldSettings = { ...this.settings };
		await this.pluginSettings.saveSettings(this.settings);

		this.diContainer.notifySettingsChanged(this.settings, oldSettings);

		if (forceUpdate && this.settingTab) {
			this.settingTab.display();
		}

		this.loggingService.info(
			"KoreaderImporterPlugin",
			"Settings saved. Services notified of changes.",
		);
	}
}
