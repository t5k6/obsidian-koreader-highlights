import type { App } from "obsidian";
import { CommandManager } from "src/services/command/CommandManager";
import { DatabaseService } from "src/services/DatabaseService";
import { MountPointService } from "src/services/device/MountPointService";
import { ScanManager } from "src/services/device/ScanManager";
import { SDRFinder } from "src/services/device/SDRFinder";
import { FileSystemService } from "src/services/FileSystemService";
import { ImportManager } from "src/services/ImportManager";
import { FrontmatterGenerator } from "src/services/parsing/FrontmatterGenerator";
import { MetadataParser } from "src/services/parsing/MetadataParser";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { ContentGenerator } from "src/services/vault/ContentGenerator";
import { DuplicateHandler } from "src/services/vault/DuplicateHandler";
import { SnapshotManager } from "src/services/vault/SnapshotManager";
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
		(app: App, match: any, message: string) =>
			new DuplicateHandlingModal(app, match, message),
	);

	// --- Level 0: Foundational & No Dependencies ---
	container.register(CacheManager, []);
	container.register(FrontmatterGenerator, []);

	// --- Level 1: Depends on Level 0 or Tokens ---
	container.register(FileSystemService, [
		VAULT_TOKEN,
		PLUGIN_TOKEN,
		CacheManager,
	]);
	container.register(DatabaseService, [PLUGIN_TOKEN, FileSystemService]);
	container.register(SDRFinder, [
		PLUGIN_TOKEN,
		CacheManager,
		FileSystemService,
	]);
	container.register(SnapshotManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		VAULT_TOKEN,
		FileSystemService,
	]);
	container.register(TemplateManager, [
		PLUGIN_TOKEN,
		VAULT_TOKEN,
		CacheManager,
		FileSystemService,
	]);
	container.register(MountPointService, [SDRFinder]);

	// --- Level 2: Depends on Level 1 ---
	container.register(ContentGenerator, [TemplateManager, PLUGIN_TOKEN]);
	container.register(MetadataParser, [SDRFinder, CacheManager]);
	container.register(ScanManager, [APP_TOKEN, PLUGIN_TOKEN, SDRFinder]);
	container.register(DuplicateHandler, [
		VAULT_TOKEN,
		APP_TOKEN,
		DUPLICATE_MODAL_FACTORY_TOKEN,
		FrontmatterGenerator,
		PLUGIN_TOKEN,
		ContentGenerator,
		DatabaseService,
		SnapshotManager,
		CacheManager,
		FileSystemService,
	]);

	// --- Level 3: Depends on Level 2 ---
	container.register(ImportManager, [
		APP_TOKEN,
		PLUGIN_TOKEN,
		SDRFinder,
		MetadataParser,
		DatabaseService,
		FrontmatterGenerator,
		ContentGenerator,
		DuplicateHandler,
		SnapshotManager,
	]);
	container.register(CommandManager, [
		ImportManager,
		ScanManager,
		MountPointService,
		CacheManager,
	]);
}
