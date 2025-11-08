import type { App } from "obsidian";
import { CacheManager } from "src/lib/cache/CacheManager";
import { IndexRepository } from "src/lib/database/indexRepository";
import type KoreaderImporterPlugin from "src/main";
import { CommandManager } from "src/services/command/CommandManager";
import { DeviceService } from "src/services/device/DeviceService";
import { FileSystemService } from "src/services/FileSystemService";
import { ImportService } from "src/services/import/ImportService";
import { LoggingService } from "src/services/LoggingService";
import { NoteEditorService } from "src/services/parsing/NoteEditorService";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { SqlJsManager } from "src/services/SqlJsManager";
import { IndexRebuildStatusService } from "src/services/ui/IndexRebuildStatusService";
import { DuplicateFinder } from "src/services/vault/DuplicateFinder";
import { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import { IndexDatabase } from "src/services/vault/index/IndexDatabase";
import { MergeHandler } from "src/services/vault/MergeHandler";
import { NotePersistenceService } from "src/services/vault/NotePersistenceService";
import { VaultBookScanner } from "src/services/vault/VaultBookScanner";
import type { DuplicateHandlingSession, DuplicateMatch } from "src/types";
import { DuplicateHandlingModal } from "src/ui/DuplicateModal";
import { StatusBarManager } from "src/ui/StatusBarManager";
import type { DIContainer } from "./DIContainer";
import {
	APP_TOKEN,
	DUPLICATE_MODAL_FACTORY_TOKEN,
	PLUGIN_TOKEN,
	SETTINGS_TOKEN,
	VAULT_TOKEN,
} from "./tokens";

/**
 * Registers services in dependency layers to ensure correct instantiation order.
 * - Level 0: Foundational (no internal dependencies).
 * - Level 1: Core I/O and State (FileSystem, Device, Caches).
 * - Level 2: Business Logic (Persistence, Merging, Indexing).
 * - Level 3: Orchestration & UI (ImportService, Commands, StatusBar).
 */
export function registerServices(
	container: DIContainer,
	plugin: KoreaderImporterPlugin,
	app: App,
) {
	// --- Register Core Values ---
	container.registerValue(APP_TOKEN, app);
	container.registerValue(VAULT_TOKEN, app.vault);
	container.registerValue(PLUGIN_TOKEN, plugin);
	container.registerValue(
		DUPLICATE_MODAL_FACTORY_TOKEN,
		(
			app: App,
			match: DuplicateMatch,
			message: string,
			session: DuplicateHandlingSession,
		) => new DuplicateHandlingModal(app, match, message, session),
	);

	// --- Level 0: Foundational (No internal dependencies) ---

	// --- Level 0.5: Depends on LoggingService ---
	container.register(CacheManager, [LoggingService]);
	container.register(NoteEditorService, [
		APP_TOKEN,
		LoggingService,
		FileSystemService,
	]);

	// --- Level 1: Depends on Level 0 or Tokens ---
	container.register(FileSystemService, [
		VAULT_TOKEN,
		PLUGIN_TOKEN,
		CacheManager,
		LoggingService,
	]);

	// Unified DeviceService (environment + scanning + statistics)
	container.register(DeviceService, [
		PLUGIN_TOKEN,
		FileSystemService,
		SqlJsManager,
		CacheManager,
		LoggingService,
	]);

	container.register(SqlJsManager, [LoggingService, FileSystemService]);
	container.register(TemplateManager, [
		PLUGIN_TOKEN,
		VAULT_TOKEN,
		CacheManager,
		FileSystemService,
		LoggingService,
	]);

	// Vault book scanner utility
	container.register(VaultBookScanner, [
		APP_TOKEN,
		FileSystemService,
		NoteEditorService,
		SETTINGS_TOKEN,
	]);

	// --- UI-specific Services ---
	container.register(StatusBarManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		IndexCoordinator,
		CommandManager,
	]);
	container.register(IndexRebuildStatusService, [
		IndexDatabase,
		LoggingService,
	]);

	// --- Level 2: Depends on Level 1 ---

	container.register(NotePersistenceService, [
		APP_TOKEN,
		NoteEditorService,
		FileSystemService,
		LoggingService,
		VaultBookScanner,
	]);

	container.register(MergeHandler, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		DUPLICATE_MODAL_FACTORY_TOKEN,
		TemplateManager,
		NotePersistenceService,
		LoggingService,
	]);
	// Index components
	container.register(IndexDatabase, [
		SqlJsManager,
		FileSystemService,
		LoggingService,
	]);

	// Index repositories (data access layer)
	container.register(IndexRepository, [IndexDatabase]);

	// IndexCoordinator handles orchestration and events
	container.register(IndexCoordinator, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		IndexDatabase,
		NoteEditorService,
		FileSystemService,
		LoggingService,
		CacheManager,
		VaultBookScanner,
		IndexRepository,
	]);

	// --- Level 2.5: Duplicate Finding
	container.register(DuplicateFinder, [
		APP_TOKEN,
		VAULT_TOKEN,
		PLUGIN_TOKEN,
		IndexCoordinator,
		NoteEditorService,
		NotePersistenceService,
		LoggingService,
		FileSystemService,
		VaultBookScanner,
		DeviceService,
	]);

	// Consolidated ImportService
	container.register(ImportService, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		DeviceService,
		IndexCoordinator,
		NotePersistenceService,
		LoggingService,
		FileSystemService,
		DuplicateFinder,
		NoteEditorService,
		TemplateManager,
		MergeHandler,
	]);

	// --- Level 3: Depends on Level 2 ---
	container.register(CommandManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		ImportService,
		DeviceService,
		CacheManager,
		LoggingService,
		IndexCoordinator,
		FileSystemService,
		NoteEditorService,
		NotePersistenceService,
	]);
}
