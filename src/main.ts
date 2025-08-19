import { Notice, Plugin } from "obsidian";
import { isErr } from "src/lib/core/result";
import { CommandManager } from "src/services/command/CommandManager";
import { FileSystemService } from "src/services/FileSystemService";
import { LoggingService } from "src/services/LoggingService";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import { SettingsTab } from "src/ui/SettingsTab";
import { StatusBarManager } from "src/ui/StatusBarManager";
import { DIContainer } from "./core/DIContainer";
import { MigrationManager } from "./core/MigrationManager";
import { PluginDataStore } from "./core/PluginDataStore";
import { registerServices } from "./core/registerServices";
import { SETTINGS_TOKEN } from "./core/tokens";
import { NotePersistenceService } from "./services/vault/NotePersistenceService";
import type { KoreaderHighlightImporterSettings } from "./types";

export default class KoreaderImporterPlugin extends Plugin {
	public settings!: KoreaderHighlightImporterSettings;
	public settingTab!: SettingsTab;
	public loggingService!: LoggingService;
	private diContainer!: DIContainer;
	private servicesInitialized = false;
	private migrationManager!: MigrationManager;
	private dataStore!: PluginDataStore;
	public templateManager!: TemplateManager;
	public localIndexService!: IndexCoordinator;
	private statusBarManager!: StatusBarManager;

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

			await this.phase("Logging & DI", async () => {
				this.initLogging();
				this.initDI();
				this.registerCoreServices();
			});

			await this.phase("Persistence & Migrations", async () => {
				await this.initPersistenceAndMigrations();
			});

			await this.phase("Core Services", async () => {
				await this.initCoreServices();
			});

			await this.phase("UI Managers", async () => {
				this.initUIManagers();
			});

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

	private async phase<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
		const t0 = (globalThis as any).performance?.now?.() ?? Date.now();
		try {
			const result = await Promise.resolve(fn());
			const t1 = (globalThis as any).performance?.now?.() ?? Date.now();
			this.loggingService?.info(
				"KoreaderImporterPlugin",
				`Phase "${name}" completed in ${(t1 - t0).toFixed(1)}ms`,
			);
			return result;
		} catch (e) {
			this.loggingService?.error(
				"KoreaderImporterPlugin",
				`Phase "${name}" failed`,
				e,
			);
			throw e;
		}
	}

	private initLogging(): void {
		this.loggingService = new LoggingService(this.app.vault);
	}

	private initDI(): void {
		this.diContainer = new DIContainer(this.loggingService);
		this.diContainer.registerValue(LoggingService, this.loggingService);
	}

	private registerCoreServices(): void {
		registerServices(this.diContainer, this, this.app);
	}

	private async initPersistenceAndMigrations(): Promise<void> {
		const fs = this.diContainer.resolve<FileSystemService>(FileSystemService);
		this.dataStore = new PluginDataStore(this, fs, this.loggingService);

		this.migrationManager = new MigrationManager(
			this.app,
			fs,
			this.loggingService,
			this.manifest.version,
		);

		await this.migrationManager.migrateLegacySettingsIfNeeded(
			this,
			this.dataStore,
		);

		const loadedData = await this.dataStore.load();
		const notePersistenceService =
			this.diContainer.resolve<NotePersistenceService>(NotePersistenceService);
		const localIndexService =
			this.diContainer.resolve<IndexCoordinator>(IndexCoordinator);
		const migratedData = await this.migrationManager.runAll(loadedData, {
			notePersistenceService,
			localIndexService,
			settings: loadedData.settings,
		});
		if (migratedData !== loadedData) {
			await this.dataStore.save(migratedData);
		}

		this.settings = migratedData.settings;
		this.diContainer.registerValue(SETTINGS_TOKEN, this.settings);
		this.loggingService.onSettingsChanged(this.settings);
		this.diContainer.notifySettingsChanged(this.settings, this.settings);
		this.loggingService.info("KoreaderImporterPlugin", "Migrations checked.");
	}

	private async initCoreServices(): Promise<void> {
		this.localIndexService =
			this.diContainer.resolve<IndexCoordinator>(IndexCoordinator);
		// Eager init for perf; IndexCoordinator.whenReady() will lazy-init if needed
		await this.localIndexService.initialize();

		this.templateManager =
			this.diContainer.resolve<TemplateManager>(TemplateManager);
		await this.templateManager.loadBuiltInTemplates();
		await this.templateManager.ensureTemplates();
		this.loggingService.info(
			"KoreaderImporterPlugin",
			"Templates initialized.",
		);
	}

	private initUIManagers(): void {
		this.statusBarManager =
			this.diContainer.resolve<StatusBarManager>(StatusBarManager);
		this.addChild(this.statusBarManager);
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
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		for (const command of commandManager.getCommands()) {
			this.addCommand(command);
		}
	}

	// --- Public API used by Settings UI ---
	public async triggerImport(): Promise<void> {
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		const res = await commandManager.executeImport();
		if (isErr(res)) {
			new Notice("Import failed. Check console for details.");
		}
	}

	public async triggerScan(): Promise<void> {
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		const res = await commandManager.executeScan();
		if (isErr(res)) {
			new Notice("Scan failed. Check console for details.");
			return;
		}
		const count = res.value.fileCount ?? 0;
		if (count === 0) {
			new Notice("Scan complete: No KOReader highlight files found.");
		} else {
			new Notice(
				`Scan complete: Report saved to "KOReader SDR Scan Report.md"`,
			);
		}
	}

	public async triggerForceImport(): Promise<void> {
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		const res = await commandManager.executeForceImport();
		if (isErr(res)) {
			new Notice("Force import failed. Check console for details.");
		}
	}

	public async triggerClearCaches(): Promise<void> {
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		const res = await commandManager.executeClearCaches();
		if (isErr(res)) {
			new Notice("Failed to clear caches. Check console for details.");
		} else {
			new Notice("KOReader Importer caches cleared.");
		}
	}

	public async triggerConvertCommentStyle(): Promise<void> {
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		const res = await commandManager.executeConvertCommentStyle();
		if (isErr(res)) new Notice("Conversion failed. Check console for details.");
	}

	public async triggerRecheckCapabilities(): Promise<void> {
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		const res = await commandManager.executeRecheckCapabilities();
		if (isErr(res)) {
			new Notice(
				"Failed to re-check capabilities. See console for details.",
				7000,
			);
			return;
		}
		if (res.value?.message) {
			new Notice(`KOReader Importer: ${res.value.message}`, 5000);
		}
	}

	public async triggerFullReset(): Promise<void> {
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		const res = await commandManager.executeFullResetWithConfirm();
		if (res.status === "cancelled") return;
		if (res.status === "success") {
			new Notice(
				"KOReader Importer has been reset. Reloading plugin now...",
				5000,
			);
		} else if (res.status === "error") {
			new Notice(
				"Error during reset. Check the developer console for details.",
				10000,
			);
		}
	}

	async saveSettings(forceUpdate: boolean = false): Promise<void> {
		const oldSettings = { ...this.settings };
		const updatedData = await this.dataStore.updateSettings(
			() => this.settings,
		);
		this.settings = updatedData.settings;
		this.diContainer.notifySettingsChanged(this.settings, oldSettings);

		if (forceUpdate && this.settingTab) {
			this.settingTab.display();
		}

		this.loggingService.info(
			"KoreaderImporterPlugin",
			"Settings saved. Services notified of changes.",
		);
	}

	/**
	 * Programmatically reloads the plugin to apply a full reset.
	 */
	public async reloadPlugin(): Promise<void> {
		this.loggingService.info("KoreaderImporterPlugin", "Reloading plugin...");
		const pluginId = this.manifest.id;
		// 'plugins' exists at runtime; the App type doesn't declare it, so cast to any
		const pluginsApi = (this.app as any).plugins;
		if (pluginsApi?.disablePlugin && pluginsApi?.enablePlugin) {
			await pluginsApi.disablePlugin(pluginId);
			await pluginsApi.enablePlugin(pluginId);
		} else {
			// Fallback: show notice if API unavailable
			new Notice(
				"Unable to reload plugin programmatically on this Obsidian version.",
				5000,
			);
		}
	}
}
