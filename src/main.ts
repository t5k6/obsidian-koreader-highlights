import { type App, Modal, Notice, Plugin } from "obsidian";
import { BookRefreshOrchestrator } from "src/services/BookRefreshOrchestrator";
import { CommandManager } from "src/services/command/CommandManager";
import { FileSystemService } from "src/services/FileSystemService";
import { LoggingService } from "src/services/LoggingService";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { LocalIndexService } from "src/services/vault/LocalIndexService";
import { SettingsTab } from "src/ui/SettingsTab";
import { StatusBarManager } from "src/ui/StatusBarManager";
import { DIContainer } from "./core/DIContainer";
import { MigrationManager } from "./core/MigrationManager";
import { PluginDataStore } from "./core/PluginDataStore";
import { registerServices } from "./core/registerServices";
import type { KoreaderHighlightImporterSettings } from "./types";

/** Confirmation modal for destructive reset */
class ResetConfirmationModal extends Modal {
	constructor(
		app: App,
		private readonly onConfirm: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Reset KOReader Importer?" });
		contentEl.createEl("p", {
			text: "This will delete the plugin's index files and caches. Your actual highlight notes in the vault are not affected.",
		});
		contentEl.createEl("p", {
			text: "This action will also reload the plugin to ensure a completely clean state. Continue?",
		});

		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = buttonContainer.createEl("button", {
			text: "Yes, Reset and Reload",
			cls: "mod-warning",
		});
		confirmBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

export default class KoreaderImporterPlugin extends Plugin {
	public settings!: KoreaderHighlightImporterSettings;
	public settingTab!: SettingsTab;
	public loggingService!: LoggingService;
	private diContainer!: DIContainer;
	private servicesInitialized = false;
	private migrationManager!: MigrationManager;
	private dataStore!: PluginDataStore;
	public templateManager!: TemplateManager;
	public localIndexService!: LocalIndexService;
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
			this.app.vault,
			fs,
			this.loggingService,
			this.manifest.version,
		);

		await this.migrationManager.migrateLegacySettingsIfNeeded(
			this,
			this.dataStore,
		);

		const loadedData = await this.dataStore.load();
		const migratedData = await this.migrationManager.runAll(loadedData);
		if (migratedData !== loadedData) {
			await this.dataStore.save(migratedData);
		}

		this.settings = migratedData.settings;
		this.loggingService.onSettingsChanged(this.settings);
		this.diContainer.notifySettingsChanged(this.settings, this.settings);
		this.loggingService.info("KoreaderImporterPlugin", "Migrations checked.");
	}

	private async initCoreServices(): Promise<void> {
		this.localIndexService =
			this.diContainer.resolve<LocalIndexService>(LocalIndexService);
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

		// Less-destructive cache clear (existing behavior)
		this.addCommand({
			id: "clear-koreader-importer-caches",
			name: "Clear in-memory caches",
			callback: () => this.triggerClearCaches(),
		});

		// Force re-scan and import (clear caches then import)
		this.addCommand({
			id: "force-import-koreader-highlights",
			name: "Force Re-scan and Import KOReader Highlights",
			callback: () => this.triggerForceImport(),
		});

		// Full reset and reload
		this.addCommand({
			id: "reset-koreader-importer",
			name: "Troubleshoot: Full Reset and Reload Plugin",
			callback: () => this.triggerFullReset(),
		});

		// Re-check capabilities (force probe refresh)
		this.addCommand({
			id: "recheck-environment-capabilities",
			name: "Troubleshoot: Re-check environment capabilities",
			callback: () => this.triggerRecheckCapabilities(),
		});

		// Refresh highlights for the currently active book note
		this.addCommand({
			id: "refresh-highlights-for-this-book",
			name: "Refresh highlights for this book",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.triggerRefreshCurrentNote(file);
				return true;
			},
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

	// Force re-scan and import (clear caches then immediately import)
	async triggerForceImport(): Promise<void> {
		if (!this.checkServiceStatus("force import")) return;
		await this.triggerClearCaches();
		await this.triggerImport();
	}

	// Trigger full reset with confirmation
	async triggerFullReset(): Promise<void> {
		if (!this.checkServiceStatus("full reset")) return;
		new ResetConfirmationModal(this.app, async () => {
			const commandManager =
				this.diContainer.resolve<CommandManager>(CommandManager);
			await commandManager.executeFullReset();
		}).open();
	}

	async triggerRecheckCapabilities(): Promise<void> {
		if (!this.checkServiceStatus("re-check capabilities")) return;
		const commandManager =
			this.diContainer.resolve<CommandManager>(CommandManager);
		await commandManager.executeRecheckCapabilities();
	}

	async triggerRefreshCurrentNote(
		file?: import("obsidian").TFile,
	): Promise<void> {
		if (!this.checkServiceStatus("refresh current note")) return;
		const active = file ?? this.app.workspace.getActiveFile();
		if (!active) {
			new Notice("No active file to refresh.", 4000);
			return;
		}
		try {
			const orchestrator = this.diContainer.resolve<BookRefreshOrchestrator>(
				BookRefreshOrchestrator,
			);
			const changed = await orchestrator.refreshNote(active);
			new Notice(
				changed
					? "KOReader highlights refreshed for this book."
					: "No changes found for this book.",
				5000,
			);
		} catch (e: any) {
			console.error("Book refresh failed", e);
			new Notice(`Refresh failed: ${e?.message ?? e}`, 7000);
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
