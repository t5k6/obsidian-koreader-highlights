import type { App, Vault } from "obsidian";
import type { LoggingService } from "src/services/LoggingService";
import type { DuplicateMatch, IDuplicateHandlingModal } from "src/types";
import type KoreaderImporterPlugin from "./KoreaderImporterPlugin";

export const APP_TOKEN = Symbol("App");
export const VAULT_TOKEN = Symbol("Vault");
export const PLUGIN_TOKEN = Symbol("KoreaderImporterPlugin");
export const LOGGING_SERVICE_TOKEN = Symbol("LoggingService");
export const DUPLICATE_MODAL_FACTORY_TOKEN = Symbol("DuplicateModalFactory");

// --- For type-hinting the container resolve method ---

export type AppToken = App;
export type VaultToken = Vault;
export type PluginToken = KoreaderImporterPlugin;
export type LoggingServiceToken = LoggingService;
export type DuplicateModalFactoryToken = (
	app: App,
	match: DuplicateMatch,
	message: string,
) => IDuplicateHandlingModal;
