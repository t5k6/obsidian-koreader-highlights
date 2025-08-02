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

export default class KoreaderImporterPlugin extends Plugin {
	public settings!: KoreaderHighlightImporterSettings;
	public settingTab!: SettingsTab;
	private pluginSettings!: PluginSettings;
	public loggingService!: LoggingService;
	private diContainer!: DIContainer;
	private servicesInitialized = false;
	private migrationManager!: MigrationManager;
	public templateManager!: TemplateManager;

	async onload() {
		console.log("KOReaderImporterPlugin: Loading...");

		await this.initialize();

		if (this.servicesInitialized) {
			this.registerPluginCommands();
			this.addSettingTab(new SettingsTab(this.app, this));
			this.loggingService.info(
				"KoreaderImporterPlugin",
				"UI components loaded.",
			);
			console.log("KOReaderImporterPlugin: Loaded successfully.");
		} else {
			this.loggingService.error(
				"KoreaderImporterPlugin",
				"Plugin loaded in a disabled state due to initialization errors.",
			);
		}
	}

	private async initialize(): Promise<void> {
		try {
			this.servicesInitialized = false;

			// Step 1: Settings
			this.pluginSettings = new PluginSettings(this);
			this.settings = await this.pluginSettings.loadSettings();

			// Step 2: Logging
			this.loggingService = new LoggingService(this.app.vault);
			this.loggingService.onSettingsChanged(this.settings);

			// Step 3: DI Container
			this.diContainer = new DIContainer(this.loggingService);
			this.diContainer.registerValue(LoggingService, this.loggingService);

			// Step 4: Services
			registerServices(this.diContainer, this, this.app);

			// Step 5: Critical Service Post-Init
			this.templateManager =
				this.diContainer.resolve<TemplateManager>(TemplateManager);
			await this.templateManager.loadBuiltInTemplates();
			await this.templateManager.ensureTemplates();
			this.loggingService.info(
				"KoreaderImporterPlugin",
				"Templates initialized.",
			);

			// Step 6: Migrations (run before services are used)
			this.migrationManager = new MigrationManager(this, this.loggingService);
			await this.migrationManager.run();
			this.loggingService.info("KoreaderImporterPlugin", "Migrations checked.");

			this.servicesInitialized = true;
			this.loggingService.info(
				"KoreaderImporterPlugin",
				"All services initialized successfully.",
			);
		} catch (error) {
			this.servicesInitialized = false;
			const errorMessage =
				"KOReader Importer failed to initialize. Check the developer console for more details. The plugin will be disabled.";
			console.error("KOReader Importer: CRITICAL BOOTSTRAP ERROR", error);
			new Notice(errorMessage, 0); // Display notice indefinitely until dismissed
		}
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

	// --- Command Registration ---
	private registerPluginCommands(): void {
		this.addCommand({
			id: "import-koreader-highlights",
			name: "Import KOReader Highlights",
			callback: () => this.triggerImport(),
		});

		this.addCommand({
			id: "scan-koreader-highlights",
			name: "Scan KOReader for Highlights",
			callback: () => this.triggerScan(),
		});

		this.addCommand({
			id: "convert-comment-style",
			name: "Convert All Files to Current Comment Style",
			callback: () => this.triggerConvertCommentStyle(),
		});
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
