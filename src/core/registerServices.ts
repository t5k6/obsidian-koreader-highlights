import type { App } from "obsidian";
import { CacheManager } from "src/lib/cache/CacheManager";
import type KoreaderImporterPlugin from "src/main";
import { CapabilityManager } from "src/services/CapabilityManager";
import { CommandManager } from "src/services/command/CommandManager";
import { DeviceService } from "src/services/device/DeviceService";
import { FileSystemService } from "src/services/FileSystemService";
import { ImportService } from "src/services/import/ImportService";
import { LoggingService } from "src/services/LoggingService";
import { FrontmatterService } from "src/services/parsing/FrontmatterService";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { SqlJsManager } from "src/services/SqlJsManager";
import { PromptService } from "src/services/ui/PromptService";
import { DuplicateFinder } from "src/services/vault/DuplicateFinder";
import { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import { IndexDatabase } from "src/services/vault/index/IndexDatabase";
import { MergeHandler } from "src/services/vault/MergeHandler";
import { NotePersistenceService } from "src/services/vault/NotePersistenceService";
import type { DuplicateHandlingSession, DuplicateMatch } from "src/types";
import { DuplicateHandlingModal } from "src/ui/DuplicateModal";
import { StatusBarManager } from "src/ui/StatusBarManager";
import type { DIContainer } from "./DIContainer";
import {
	APP_TOKEN,
	DUPLICATE_MODAL_FACTORY_TOKEN,
	PLUGIN_TOKEN,
	VAULT_TOKEN,
} from "./tokens";

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
	container.register(FrontmatterService, [
		APP_TOKEN,
		LoggingService,
		FileSystemService,
	]);

	container.register(NotePersistenceService, [
		APP_TOKEN,
		FrontmatterService,
		FileSystemService,
		LoggingService,
		CapabilityManager,
	]);

	// --- Level 1: Depends on Level 0 or Tokens ---
	container.register(FileSystemService, [
		VAULT_TOKEN,
		PLUGIN_TOKEN,
		CacheManager,
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
	container.register(CapabilityManager, [
		APP_TOKEN,
		FileSystemService,
		LoggingService,
	]);
	container.register(TemplateManager, [
		PLUGIN_TOKEN,
		VAULT_TOKEN,
		CacheManager,
		FileSystemService,
		LoggingService,
	]);

	// --- UI-specific Services ---
	container.register(StatusBarManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		IndexCoordinator,
		CommandManager,
	]);

	// Prompt/Interaction service
	// Policy: reserve symbol tokens for factories or primitives only. Resolve concrete services by class.
	container.register(PromptService, [APP_TOKEN]);

	// --- Level 2: Depends on Level 1 ---

	container.register(MergeHandler, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		DUPLICATE_MODAL_FACTORY_TOKEN,
		FrontmatterService,
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

	// IndexCoordinator handles orchestration and events
	container.register(IndexCoordinator, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		IndexDatabase,
		FrontmatterService,
		FileSystemService,
		LoggingService,
		CacheManager,
	]);

	// LocalIndexService removed – use IndexCoordinator directly.

	// --- Level 2.5: Duplicate Finding
	container.register(DuplicateFinder, [
		APP_TOKEN,
		VAULT_TOKEN,
		PLUGIN_TOKEN,
		IndexCoordinator,
		FrontmatterService,
		NotePersistenceService,
		LoggingService,
		FileSystemService,
	]);

	// Consolidated ImportService
	container.register(ImportService, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		DeviceService,
		IndexCoordinator,
		NotePersistenceService,
		LoggingService,
		PromptService,
		FileSystemService,
		DuplicateFinder,
		FrontmatterService,
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
		CapabilityManager,
		FrontmatterService,
	]);
}
