import type { App } from "obsidian";
import { CacheManager } from "src/lib/cache/CacheManager";
import { initPathingCaches } from "src/lib/pathing/pathingUtils";
import type KoreaderImporterPlugin from "src/main";
import { CapabilityManager } from "src/services/CapabilityManager";
import { CommandManager } from "src/services/command/CommandManager";
import { DeviceService } from "src/services/device/DeviceService";
import { FileSystemService } from "src/services/FileSystemService";
import { ImportPipelineService } from "src/services/ImportPipelineService";
import { ImportExecutorService } from "src/services/import/ImportExecutorService";
import { ImportPlannerService } from "src/services/import/ImportPlannerService";
import { LoggingService } from "src/services/LoggingService";
import { FrontmatterService } from "src/services/parsing/FrontmatterService";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { SqlJsManager } from "src/services/SqlJsManager";
import { PromptService } from "src/services/ui/PromptService";
import { DuplicateFinder } from "src/services/vault/DuplicateFinder";
import { FileNameGenerator } from "src/services/vault/FileNameGenerator";
import { LocalIndexService } from "src/services/vault/LocalIndexService";
import { MergeHandler } from "src/services/vault/MergeHandler";
import { MergeService } from "src/services/vault/MergeService";
import { NoteCreationService } from "src/services/vault/NoteCreationService";
import { NoteIdentityService } from "src/services/vault/NoteIdentityService";
import { SnapshotManager } from "src/services/vault/SnapshotManager";
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
	// Register pathing slug caches with the central CacheManager so global clears affect them.
	initPathingCaches(container.resolve(CacheManager));
	container.register(FileNameGenerator, [LoggingService]);
	container.register(FrontmatterService, [
		APP_TOKEN,
		LoggingService,
		FileSystemService,
	]);
	container.register(NoteIdentityService, [
		APP_TOKEN,
		FrontmatterService,
		LoggingService,
		FileSystemService,
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
	container.register(SnapshotManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		FileSystemService,
		LoggingService,
		FrontmatterService,
		NoteIdentityService,
		CapabilityManager,
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
		LocalIndexService,
		CommandManager,
	]);

	// Prompt/Interaction service
	// Policy: reserve symbol tokens for factories or primitives only. Resolve concrete services by class.
	container.register(PromptService, [APP_TOKEN]);

	// --- Level 2: Depends on Level 1 ---
	container.register(MergeService, [
		PLUGIN_TOKEN,
		SnapshotManager,
		FrontmatterService,
		LoggingService,
		FileSystemService,
		NoteIdentityService,
		TemplateManager,
	]);

	container.register(MergeHandler, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		DUPLICATE_MODAL_FACTORY_TOKEN,
		MergeService,
		SnapshotManager,
		FileSystemService,
		LoggingService,
		CapabilityManager,
		NoteIdentityService,
	]);
	container.register(LocalIndexService, [
		PLUGIN_TOKEN,
		APP_TOKEN,
		FileSystemService,
		CacheManager,
		SqlJsManager,
		LoggingService,
		FrontmatterService,
		CapabilityManager,
	]);

	// --- Level 2.5: Duplicate Finding
	container.register(DuplicateFinder, [
		APP_TOKEN,
		VAULT_TOKEN,
		PLUGIN_TOKEN,
		FileNameGenerator,
		LocalIndexService,
		FrontmatterService,
		SnapshotManager,
		NoteIdentityService,
		CacheManager,
		LoggingService,
		FileSystemService,
	]);

	// Helper for creating notes (used by executor)
	container.register(NoteCreationService, [
		FileSystemService,
		FrontmatterService,
		FileNameGenerator,
		SnapshotManager,
		NoteIdentityService,
		LoggingService,
		TemplateManager,
		PLUGIN_TOKEN,
	]);

	// New import pipeline services
	container.register(ImportPlannerService, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		FileSystemService,
		LocalIndexService,
		DeviceService,
		DuplicateFinder,
		LoggingService,
	]);
	container.register(ImportExecutorService, [
		PLUGIN_TOKEN,
		MergeHandler,
		NoteCreationService,
		FrontmatterService,
		LoggingService,
		FileSystemService,
		FileNameGenerator,
		SnapshotManager,
	]);

	// Lean orchestrator depending on planner + executor
	container.register(ImportPipelineService, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		DeviceService,
		LocalIndexService,
		SnapshotManager,
		LoggingService,
		PromptService,
		ImportPlannerService,
		ImportExecutorService,
	]);

	// --- Level 3: Depends on Level 2 ---
	container.register(CommandManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		ImportPipelineService,
		DeviceService,
		CacheManager,
		LoggingService,
		LocalIndexService,
		CapabilityManager,
		FrontmatterService,
		FileSystemService,
	]);
}
