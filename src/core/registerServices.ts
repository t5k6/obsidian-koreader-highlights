import type { App } from "obsidian";
import { CacheManager } from "src/lib/cache/CacheManager";
import type KoreaderImporterPlugin from "src/main";
import { BookRefreshOrchestrator } from "src/services/BookRefreshOrchestrator";
import { CapabilityManager } from "src/services/CapabilityManager";
import { CommandManager } from "src/services/command/CommandManager";
import { DeviceStatisticsService } from "src/services/device/DeviceStatisticsService";
import { KoreaderEnvironmentService } from "src/services/device/KoreaderEnvironmentService";
import { SDRFinder } from "src/services/device/SDRFinder";
import { FileSystemService } from "src/services/FileSystemService";
import { ImportPipelineService } from "src/services/ImportPipelineService";
import { ImportExecutorService } from "src/services/import/ImportExecutorService";
import { ImportPlannerService } from "src/services/import/ImportPlannerService";
import { LoggingService } from "src/services/LoggingService";
import { FrontmatterGenerator } from "src/services/parsing/FrontmatterGenerator";
import { FrontmatterService } from "src/services/parsing/FrontmatterService";
import { MetadataParser } from "src/services/parsing/MetadataParser";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { SqlJsManager } from "src/services/SqlJsManager";
import { ObsidianPromptService } from "src/services/ui/ObsidianPromptService";
import { ContentGenerator } from "src/services/vault/ContentGenerator";
import { DuplicateFinder } from "src/services/vault/DuplicateFinder";
import { FileNameGenerator } from "src/services/vault/FileNameGenerator";
import { LocalIndexService } from "src/services/vault/LocalIndexService";
import { MergeHandler } from "src/services/vault/MergeHandler";
import { MergeService } from "src/services/vault/MergeService";
import { NoteCreationService } from "src/services/vault/NoteCreationService";
import { NoteIdentityService } from "src/services/vault/NoteIdentityService";
import { NoteMaintenanceService } from "src/services/vault/NoteMaintenanceService";
import { SnapshotManager } from "src/services/vault/SnapshotManager";
import type { DuplicateHandlingSession, DuplicateMatch } from "src/types";
import { DuplicateHandlingModal } from "src/ui/DuplicateModal";
import { StatusBarManager } from "src/ui/StatusBarManager";
import type { DIContainer } from "./DIContainer";
import {
	APP_TOKEN,
	DUPLICATE_MODAL_FACTORY_TOKEN,
	PLUGIN_TOKEN,
	PROMPT_SERVICE_TOKEN,
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
	container.register(FrontmatterGenerator, []);

	// --- Level 0.5: Depends on LoggingService ---
	container.register(CacheManager, [LoggingService]);
	container.register(FileNameGenerator, [LoggingService]);
	container.register(FrontmatterService, [APP_TOKEN, LoggingService]);
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

	// Central KOReader environment discovery
	container.register(KoreaderEnvironmentService, [
		PLUGIN_TOKEN,
		FileSystemService,
		CacheManager,
		LoggingService,
	]);

	// Orchestrator for single-book refresh
	container.register(BookRefreshOrchestrator, [
		LocalIndexService,
		ImportPipelineService,
		SDRFinder,
		KoreaderEnvironmentService,
		FileSystemService,
		LoggingService,
	]);
	container.register(SqlJsManager, [LoggingService, FileSystemService]);
	container.register(SDRFinder, [
		PLUGIN_TOKEN,
		CacheManager,
		FileSystemService,
		LoggingService,
		KoreaderEnvironmentService,
	]);
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

	// Maintenance utilities for existing notes (non-import)
	container.register(NoteMaintenanceService, [
		PLUGIN_TOKEN,
		FileSystemService,
		FrontmatterService,
		LoggingService,
		CacheManager,
	]);

	// --- UI-specific Services ---
	container.register(StatusBarManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		LocalIndexService,
		BookRefreshOrchestrator,
	]);

	// Prompt/Interaction service
	container.register(ObsidianPromptService, [APP_TOKEN]);
	container.registerValue(
		PROMPT_SERVICE_TOKEN,
		container.resolve(ObsidianPromptService),
	);

	// --- Level 2: Depends on Level 1 ---
	container.register(ContentGenerator, [TemplateManager, PLUGIN_TOKEN]);
	container.register(MetadataParser, [SDRFinder, CacheManager, LoggingService]);
	container.register(MergeService, [
		PLUGIN_TOKEN,
		SnapshotManager,
		FrontmatterService,
		FrontmatterGenerator,
		ContentGenerator,
		LoggingService,
		FileSystemService,
		NoteIdentityService,
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
		FrontmatterGenerator,
		ContentGenerator,
		FileNameGenerator,
		SnapshotManager,
		NoteIdentityService,
		LoggingService,
		PLUGIN_TOKEN,
	]);

	// New import pipeline services
	container.register(ImportPlannerService, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		FileSystemService,
		LocalIndexService,
		MetadataParser,
		SDRFinder,
		DeviceStatisticsService,
		DuplicateFinder,
		LoggingService,
	]);
	container.register(ImportExecutorService, [
		PLUGIN_TOKEN,
		ContentGenerator,
		MergeHandler,
		NoteCreationService,
		FrontmatterService,
		FrontmatterGenerator,
		LoggingService,
		FileSystemService,
		FileNameGenerator,
		SnapshotManager,
	]);

	// Lean orchestrator depending on planner + executor
	container.register(ImportPipelineService, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		SDRFinder,
		LocalIndexService,
		SnapshotManager,
		LoggingService,
		PROMPT_SERVICE_TOKEN,
		ImportPlannerService,
		ImportExecutorService,
	]);

	// --- Level 3: Depends on Level 2 ---
	container.register(CommandManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		ImportPipelineService,
		SDRFinder,
		KoreaderEnvironmentService,
		CacheManager,
		LoggingService,
		LocalIndexService,
		CapabilityManager,
		NoteMaintenanceService,
		FileSystemService,
	]);
	container.register(DeviceStatisticsService, [
		PLUGIN_TOKEN,
		FileSystemService,
		SqlJsManager,
		LoggingService,
		CacheManager,
		KoreaderEnvironmentService,
	]);
}
