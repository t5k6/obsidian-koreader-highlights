import type { App } from "obsidian";
import { CommandManager } from "src/services/command/CommandManager";
import { DeviceStatisticsService } from "src/services/device/DeviceStatisticsService";
import { ScanManager } from "src/services/device/ScanManager";
import { SDRFinder } from "src/services/device/SDRFinder";
import { FileSystemService } from "src/services/FileSystemService";
import { ImportManager } from "src/services/ImportManager";
import { LoggingService } from "src/services/LoggingService";
import { FrontmatterGenerator } from "src/services/parsing/FrontmatterGenerator";
import { FrontmatterService } from "src/services/parsing/FrontmatterService";
import { MetadataParser } from "src/services/parsing/MetadataParser";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { SqlJsManager } from "src/services/SqlJsManager";
import { ContentGenerator } from "src/services/vault/ContentGenerator";
import { DuplicateFinder } from "src/services/vault/DuplicateFinder";
import { DuplicateHandler } from "src/services/vault/DuplicateHandler";
import { FileNameGenerator } from "src/services/vault/FileNameGenerator";
import ImportIndexService from "src/services/vault/ImportIndexService";
import { LocalIndexService } from "src/services/vault/LocalIndexService";
import { MergeService } from "src/services/vault/MergeService";
import { SnapshotManager } from "src/services/vault/SnapshotManager";
import type { DuplicateMatch } from "src/types";
import { DuplicateHandlingModal } from "src/ui/DuplicateModal";
import { CacheManager } from "src/utils/cache/CacheManager";
import type { DIContainer } from "./DIContainer";
import type KoreaderImporterPlugin from "./KoreaderImporterPlugin";
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
		(app: App, match: DuplicateMatch, message: string) =>
			new DuplicateHandlingModal(app, match, message),
	);

	// --- Level 0: Foundational (No internal dependencies) ---
	container.register(LoggingService, [VAULT_TOKEN]);
	container.register(FrontmatterGenerator, []);

	// --- Level 0.5: Depends on LoggingService ---
	container.register(CacheManager, [LoggingService]);
	container.register(FileNameGenerator, [LoggingService]);
	container.register(FrontmatterService, [APP_TOKEN, LoggingService]);

	// --- Level 1: Depends on Level 0 or Tokens ---
	container.register(FileSystemService, [
		VAULT_TOKEN,
		PLUGIN_TOKEN,
		CacheManager,
	]);
	container.register(SqlJsManager, [LoggingService, FileSystemService]);
	container.register(SDRFinder, [
		PLUGIN_TOKEN,
		CacheManager,
		FileSystemService,
		LoggingService,
	]);
	container.register(SnapshotManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
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

	// --- Level 2: Depends on Level 1 ---
	container.register(ContentGenerator, [TemplateManager, PLUGIN_TOKEN]);
	container.register(MetadataParser, [SDRFinder, CacheManager, LoggingService]);
	container.register(ScanManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		SDRFinder,
		FileSystemService,
		LoggingService,
	]);
	container.register(MergeService, [
		APP_TOKEN,
		VAULT_TOKEN,
		PLUGIN_TOKEN,
		SnapshotManager,
		FrontmatterService,
		FrontmatterGenerator,
		ContentGenerator,
		LoggingService,
	]);
	container.register(DuplicateHandler, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		DUPLICATE_MODAL_FACTORY_TOKEN,
		MergeService,
		SnapshotManager,
		FileSystemService,
		LoggingService,
	]);
	container.register(LocalIndexService, [
		PLUGIN_TOKEN,
		APP_TOKEN,
		FileSystemService,
		CacheManager,
		SqlJsManager,
		LoggingService,
		FrontmatterService,
	]);

	// Register ImportIndexService (low-level, before ImportManager)
	container.register(ImportIndexService, [
		PLUGIN_TOKEN,
		APP_TOKEN,
		FileSystemService,
		LoggingService,
	]);

	// --- Level 2.5: Duplicate Finding
	container.register(DuplicateFinder, [
		VAULT_TOKEN,
		PLUGIN_TOKEN,
		LocalIndexService,
		FrontmatterService,
		SnapshotManager,
		CacheManager,
		LoggingService,
	]);

	// --- Level 3: Depends on Level 2 ---
	container.register(ImportManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		FileNameGenerator,
		SDRFinder,
		MetadataParser,
		DeviceStatisticsService,
		LocalIndexService,
		FrontmatterGenerator,
		ContentGenerator,
		DuplicateFinder,
		DuplicateHandler,
		SnapshotManager,
		LoggingService,
		FileSystemService,
		FrontmatterService,
		ImportIndexService,
	]);
	container.register(CommandManager, [
		PLUGIN_TOKEN,
		ImportManager,
		ScanManager,
		SDRFinder,
		CacheManager,
		LoggingService,
		ImportIndexService,
		LocalIndexService,
	]);
	container.register(DeviceStatisticsService, [
		PLUGIN_TOKEN,
		FileSystemService,
		SqlJsManager,
		LoggingService,
		CacheManager,
	]);
}
