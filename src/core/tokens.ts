import type { App, Vault } from "obsidian";
import type KoreaderImporterPlugin from "src/main";
import type {
	DuplicateHandlingSession,
	DuplicateMatch,
	IDuplicateHandlingModal,
} from "src/types";

export const APP_TOKEN = Symbol("App");
export const VAULT_TOKEN = Symbol("Vault");
export const PLUGIN_TOKEN = Symbol("KoreaderImporterPlugin");
export const DUPLICATE_MODAL_FACTORY_TOKEN = Symbol("DuplicateModalFactory");
export const SETTINGS_TOKEN = Symbol("KoreaderHighlightImporterSettings");

// --- For type-hinting the container resolve method ---

export type AppToken = App;
export type VaultToken = Vault;
export type PluginToken = KoreaderImporterPlugin;
export type DuplicateModalFactoryToken = (
	app: App,
	match: DuplicateMatch,
	message: string,
	session: DuplicateHandlingSession,
) => IDuplicateHandlingModal;
