import type { Plugin } from "obsidian";
import { Mutex } from "src/lib/concurrency/concurrency";
import { isErr } from "src/lib/core/result";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type { KoreaderHighlightImporterSettings, PluginData } from "src/types";
import { normalizePluginData, normalizeSettings } from "./settingsSchema";

export class PluginDataStore {
	private readonly mutex = new Mutex();
	private cached: PluginData | null = null;

	constructor(
		_plugin: Plugin,
		private fs: FileSystemService,
		private log: LoggingService,
	) {}

	private dataPath(): string {
		return "data.json";
	}
	private backupPath(): string {
		return "data.json.bak";
	}

	public async load(): Promise<PluginData> {
		return this.mutex.lock(async () => {
			if (this.cached) return this.cached;

			const ensured = await this.fs.ensurePluginDataDir();
			if (isErr(ensured)) {
				// Type-safe error access
				const error = ensured.error;
				this.log.warn(
					"PluginDataStore: failed to ensure plugin data dir",
					error,
				);
			}

			let data = await this.fs.tryReadPluginDataJson(this.dataPath());
			if (!data) {
				this.log.warn("PluginDataStore: data.json unreadable, trying backup.");
				data = await this.fs.tryReadPluginDataJson(this.backupPath());
			}
			if (!data) {
				this.log.warn("PluginDataStore: No valid data found. Using defaults.");
				data = {};
			}

			const normalized = this.normalize(data);
			this.cached = normalized;
			return normalized;
		});
	}

	private normalize = normalizePluginData;

	public async save(data: PluginData): Promise<void> {
		await this.mutex.lock(async () => {
			const ensured = await this.fs.ensurePluginDataDir();
			if (isErr(ensured)) {
				// Type-safe error access
				const error = ensured.error;
				this.log.warn(
					"PluginDataStore: failed to ensure plugin data dir before save",
					error,
				);
			}

			const primaryResult = await this.fs.writePluginDataJsonAtomic(
				this.dataPath(),
				data,
			);
			if (isErr(primaryResult)) {
				this.log.error(
					"PluginDataStore: failed to save primary data.json",
					primaryResult.error,
				);
				throw primaryResult.error;
			}

			const backupResult = await this.fs.writePluginDataJsonAtomic(
				this.backupPath(),
				data,
			);
			if (isErr(backupResult)) {
				this.log.warn(
					"PluginDataStore: failed to update backup",
					backupResult.error,
				);
			}

			this.cached = data;
		});
	}

	public async saveSettings(
		newSettings: KoreaderHighlightImporterSettings,
	): Promise<PluginData> {
		const curr = await this.load();
		const next: PluginData = {
			...curr,
			settings: normalizeSettings(newSettings), // Always normalize
		};
		await this.save(next);
		return next;
	}

	public async updateSettings(
		updater: (
			current: KoreaderHighlightImporterSettings,
		) => Partial<KoreaderHighlightImporterSettings>,
	): Promise<PluginData> {
		const curr = await this.load();
		const newPartial = updater(curr.settings);
		const nextSettings = { ...curr.settings, ...newPartial };
		return this.saveSettings(nextSettings);
	}
}
