import type { App, Plugin } from "obsidian";
import { ContentGenerator } from "../services/ContentGenerator";
import { DatabaseService } from "../services/DatabaseService";
import { DuplicateHandler } from "../services/DuplicateHandler";
import { FrontmatterGenerator } from "../services/FrontmatterGenerator";
import { ImportManager } from "../services/ImportManager";
import { MetadataParser } from "../services/MetadataParser";
import { ScanManager } from "../services/ScanManager";
import { SDRFinder } from "../services/SDRFinder";
import { TemplateManager } from "../services/TemplateManager";
import type {
    DuplicateMatch,
    IDuplicateHandlingModal,
    KoreaderHighlightImporterSettings,
} from "../types";
import { DuplicateHandlingModal } from "../ui/DuplicateModal";
import { DIContainer } from "./DIContainer";

export class ServiceInitializer {
    static init(
        container: DIContainer,
        plugin: Plugin,
        app: App,
        settings: KoreaderHighlightImporterSettings,
    ) {
        // Register core services
        container.register(SDRFinder, new SDRFinder(settings));
        container.register(DatabaseService, new DatabaseService(settings));
        container.register(
            TemplateManager,
            new TemplateManager(app.vault, settings),
        );
        container.register(FrontmatterGenerator, new FrontmatterGenerator());

        // Register dependent services
        container.register(
            MetadataParser,
            new MetadataParser(settings, container.resolve(SDRFinder)),
        );

        container.register(
            ContentGenerator,
            new ContentGenerator(container.resolve(TemplateManager), settings),
        );

        // Define modal factory (same as original implementation)
        const modalFactory = (
            app: App,
            match: DuplicateMatch,
            message: string,
        ): IDuplicateHandlingModal => {
            return new DuplicateHandlingModal(app, match, message);
        };

        container.register(
            DuplicateHandler,
            new DuplicateHandler(
                app.vault,
                app,
                modalFactory,
                settings,
                container.resolve(FrontmatterGenerator),
                plugin,
            ),
        );

        container.register(
            ImportManager,
            new ImportManager(
                app,
                settings,
                container.resolve(SDRFinder),
                container.resolve(MetadataParser),
                container.resolve(DatabaseService),
                container.resolve(FrontmatterGenerator),
                container.resolve(ContentGenerator),
                container.resolve(DuplicateHandler),
            ),
        );

        container.register(
            ScanManager,
            new ScanManager(app, settings, container.resolve(SDRFinder)),
        );
    }
}
