import type { Plugin } from "obsidian";
import { Mutex } from "src/lib/concurrency/concurrency";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import {
	CURRENT_SCHEMA_VERSION,
	type KoreaderHighlightImporterSettings,
	type PluginData,
} from "src/types";
import { normalizeSettings } from "./settingsSchema";

export class PluginDataStore {
	private readonly mutex = new Mutex();
	private cached: PluginData | null = null;

	constructor(
		private plugin: Plugin,
		private fs: FileSystemService,
		private log: LoggingService,
	) {}

	private dataPath(): string {
		return this.fs.joinPluginDataPath("data.json");
	}
	private backupPath(): string {
		return this.fs.joinPluginDataPath("data.json.bak");
	}

	public async load(): Promise<PluginData> {
		return this.mutex.lock(async () => {
			if (this.cached) return this.cached;

			await this.fs.ensurePluginDataDirExists();

			const readJson = async (p: string): Promise<any | null> => {
				try {
					const raw = await this.plugin.app.vault.adapter.read(p);
					return JSON.parse(raw);
				} catch (_e) {
					return null;
				}
			};

			let data = await readJson(this.dataPath());
			if (!data) {
				this.log.warn("PluginDataStore: data.json unreadable, trying backup.");
				data = await readJson(this.backupPath());
			}
			if (!data) {
				this.log.warn("PluginDataStore: No valid data found. Using defaults.");
				data = {};
			}

			const normalized = this.normalizeDataShape(data);
			this.cached = normalized;
			return normalized;
		});
	}

	private normalizeDataShape(raw: any): PluginData {
		const settings = normalizeSettings(raw.settings ?? {});
		const appliedMigrations: string[] = Array.isArray(raw.appliedMigrations)
			? raw.appliedMigrations
			: [];
		const lastPluginMigratedTo =
			typeof raw.lastPluginMigratedTo === "string"
				? raw.lastPluginMigratedTo
				: undefined;

		return {
			schemaVersion: Number.isInteger(raw.schemaVersion)
				? raw.schemaVersion
				: CURRENT_SCHEMA_VERSION,
			settings,
			appliedMigrations,
			lastPluginMigratedTo,
		};
	}

	public async save(data: PluginData): Promise<void> {
		await this.mutex.lock(async () => {
			// Ensure plugin data directory exists prior to writing
			await this.fs.ensurePluginDataDirExists();
			const json = JSON.stringify(data, null, 2);
			const dst = this.dataPath();
			const bak = this.backupPath();

			// Use atomic write that safely handles destination already existing.
			await this.fs.writeVaultBinaryAtomic(
				dst,
				new TextEncoder().encode(json).buffer,
			);
			try {
				await this.plugin.app.vault.adapter.write(bak, json);
			} catch (e) {
				this.log.warn("PluginDataStore: failed to update backup", e as any);
			}

			try {
				const roundTrip = await this.plugin.app.vault.adapter.read(dst);
				JSON.parse(roundTrip);
			} catch (e) {
				this.log.error("PluginDataStore: write verification failed", e as any);
			}

			this.cached = data;
		});
	}

	public async updateSettings(
		updater: (
			curr: KoreaderHighlightImporterSettings,
		) => KoreaderHighlightImporterSettings,
	): Promise<PluginData> {
		const curr = await this.load();
		const next: PluginData = {
			...curr,
			settings: normalizeSettings(updater(curr.settings)),
		};
		await this.save(next);
		return next;
	}
}
