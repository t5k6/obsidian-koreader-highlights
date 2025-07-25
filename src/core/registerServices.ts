import type { App } from "obsidian";
import { CommandManager } from "src/services/CommandManager";
import { ContentGenerator } from "src/services/ContentGenerator";
import { DatabaseService } from "src/services/DatabaseService";
import { DuplicateHandler } from "src/services/DuplicateHandler";
import { FrontmatterGenerator } from "src/services/FrontmatterGenerator";
import { ImportManager } from "src/services/ImportManager";
import { MetadataParser } from "src/services/MetadataParser";
import { MountPointService } from "src/services/MountPointService";
import { ScanManager } from "src/services/ScanManager";
import { SDRFinder } from "src/services/SDRFinder";
import { SnapshotManager } from "src/services/SnapshotManager";
import { TemplateManager } from "src/services/TemplateManager";
import type { DuplicateMatch, IDuplicateHandlingModal } from "src/types";
import { DuplicateHandlingModal } from "src/ui/DuplicateModal";
import type { DIContainer } from "./DIContainer";
import type KoreaderImporterPlugin from "./KoreaderImporterPlugin";

export function registerServices(
	container: DIContainer,
	plugin: KoreaderImporterPlugin,
	app: App,
) {
	/* ---------- core singletons ---------- */
	const sdrFinder = new SDRFinder(plugin);
	const dbService = new DatabaseService(plugin);
	const templateManager = new TemplateManager(plugin, app.vault);
	const frontmatterGen = new FrontmatterGenerator();
	const snapshotManager = new SnapshotManager(app, plugin, app.vault);
	const mountPointService = new MountPointService(sdrFinder);

	container
		.registerSingleton(SDRFinder, sdrFinder)
		.registerSingleton(DatabaseService, dbService)
		.registerSingleton(TemplateManager, templateManager)
		.registerSingleton(FrontmatterGenerator, frontmatterGen)
		.registerSingleton(SnapshotManager, snapshotManager)
		.registerSingleton(MountPointService, mountPointService);

	/* ---------- dependent singletons ---------- */
	const metadataParser = new MetadataParser(sdrFinder);
	const contentGen = new ContentGenerator(templateManager, plugin);

	const modalFactory = (
		app: App,
		match: DuplicateMatch,
		message: string,
	): IDuplicateHandlingModal => new DuplicateHandlingModal(app, match, message);

	const dupHandler = new DuplicateHandler(
		app.vault,
		app,
		modalFactory,
		frontmatterGen,
		plugin,
		contentGen,
		dbService,
		snapshotManager,
	);

	const importManager = new ImportManager(
		app,
		plugin,
		sdrFinder,
		metadataParser,
		dbService,
		frontmatterGen,
		contentGen,
		dupHandler,
		snapshotManager,
	);

	const scanManager = new ScanManager(app, plugin, sdrFinder);

	container
		.registerSingleton(MetadataParser, metadataParser)
		.registerSingleton(ContentGenerator, contentGen)
		.registerSingleton(DuplicateHandler, dupHandler)
		.registerSingleton(ImportManager, importManager)
		.registerSingleton(ScanManager, scanManager);

	/* ---------- command/action coordinator ---------- */
	const commandManager = new CommandManager(
		importManager,
		scanManager,
		mountPointService,
	);
	container.registerSingleton(CommandManager, commandManager);
}