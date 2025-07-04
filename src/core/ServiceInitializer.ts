import type { App } from "obsidian";
import { ContentGenerator } from "../services/ContentGenerator";
import { DatabaseService } from "../services/DatabaseService";
import { DuplicateHandler } from "../services/DuplicateHandler";
import { FrontmatterGenerator } from "../services/FrontmatterGenerator";
import { ImportManager } from "../services/ImportManager";
import { MetadataParser } from "../services/MetadataParser";
import { ScanManager } from "../services/ScanManager";
import { SDRFinder } from "../services/SDRFinder";
import { SnapshotManager } from "../services/SnapshotManager";
import { TemplateManager } from "../services/TemplateManager";
import type {
	DuplicateMatch,
	IDuplicateHandlingModal,
	KoreaderHighlightImporterSettings,
} from "../types";
import { DuplicateHandlingModal } from "../ui/DuplicateModal";
import type { DIContainer } from "./DIContainer";
import type KoreaderImporterPlugin from "./KoreaderImporterPlugin";

export class ServiceInitializer {
	static init(
		container: DIContainer,
		plugin: KoreaderImporterPlugin,
		app: App,
		settings: KoreaderHighlightImporterSettings,
	) {
		// Register core services
		container.registerSingleton(SDRFinder, new SDRFinder(plugin));
		container.registerSingleton(DatabaseService, new DatabaseService(plugin));
		container.registerSingleton(
			TemplateManager,
			new TemplateManager(plugin, app.vault),
		);
		container.registerSingleton(
			FrontmatterGenerator,
			new FrontmatterGenerator(),
		);

		container.registerSingleton(
			SnapshotManager,
			new SnapshotManager(app, plugin, app.vault)
		);

		// Register dependent services
		container.registerSingleton(
			MetadataParser,
			new MetadataParser(settings, container.resolve(SDRFinder)),
		);

		container.registerSingleton(
			ContentGenerator,
			new ContentGenerator(container.resolve(TemplateManager), plugin),
		);

		// Define modal factory (same as original implementation)
		const modalFactory = (
			app: App,
			match: DuplicateMatch,
			message: string,
		): IDuplicateHandlingModal => {
			return new DuplicateHandlingModal(app, match, message);
		};

		container.registerSingleton(
			DuplicateHandler,
			new DuplicateHandler(
				app.vault,
				app,
				modalFactory,
				container.resolve(FrontmatterGenerator),
				plugin,
				container.resolve(ContentGenerator),
				container.resolve(DatabaseService),
				container.resolve(SnapshotManager),
			),
		);

		container.registerSingleton(
			ImportManager,
			new ImportManager(
				app,
				plugin,
				container.resolve(SDRFinder),
				container.resolve(MetadataParser),
				container.resolve(DatabaseService),
				container.resolve(FrontmatterGenerator),
				container.resolve(ContentGenerator),
				container.resolve(DuplicateHandler),
				container.resolve(SnapshotManager),
			),
		);

		container.registerSingleton(
			ScanManager,
			new ScanManager(app, plugin, container.resolve(SDRFinder)),
		);
	}
}
