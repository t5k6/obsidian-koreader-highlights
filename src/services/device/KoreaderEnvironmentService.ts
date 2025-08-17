import path from "node:path";
import type { CacheManager } from "src/lib/cache/CacheManager";
import { memoizeAsync } from "src/lib/cache/CacheManager";
import type KoreaderImporterPlugin from "src/main";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type {
	KoreaderHighlightImporterSettings,
	SettingsObserver,
} from "src/types";
import { detectLayout } from "./layouts";
import type { KOReaderEnvironment } from "./types";

const MAX_UP_DEPTH = 25;

export class KoreaderEnvironmentService implements SettingsObserver {
	private readonly log;
	private getEnvironmentMemoized: (
		settingsKey: string,
	) => Promise<KOReaderEnvironment | null>;

	constructor(
		private plugin: KoreaderImporterPlugin,
		private fs: FileSystemService,
		private cacheManager: CacheManager,
		logging: LoggingService,
	) {
		this.log = logging.scoped("KoreaderEnvironmentService");

		this.getEnvironmentMemoized = memoizeAsync(
			this.cacheManager.createMap("env.discovery"),
			(_: string) => this._resolveEnvironment(),
		);
	}

	onSettingsChanged(newSettings: KoreaderHighlightImporterSettings): void {
		const oldSettings = this.plugin.settings;
		if (
			newSettings.koreaderScanPath !== oldSettings.koreaderScanPath ||
			newSettings.statsDbPathOverride !== oldSettings.statsDbPathOverride
		) {
			this.cacheManager.clear("env.discovery");
			this.log.info(
				"Environment settings changed, discovery cache invalidated.",
			);
		}
	}

	// The single public entry point for consumers (memoized)
	public async getEnvironment(): Promise<KOReaderEnvironment | null> {
		return this.getEnvironmentMemoized(this._settingsKey());
	}

	// Convenience getters for consumers
	public async getActiveScanPath(): Promise<string | null> {
		return (await this.getEnvironment())?.scanPath ?? null;
	}
	public async getDeviceRoot(): Promise<string | null> {
		return (await this.getEnvironment())?.rootPath ?? null;
	}
	public async getStatsDbPath(): Promise<string | null> {
		return (await this.getEnvironment())?.statsDbPath ?? null;
	}

	private _settingsKey(): string {
		const s = this.plugin.settings;
		const scan = s.koreaderScanPath?.trim() || "";
		const override = s.statsDbPathOverride?.trim() || "";
		return `${scan}__${override}`;
	}

	private async _resolveEnvironment(): Promise<KOReaderEnvironment | null> {
		const scanPath = await this._validateScanPath();
		if (!scanPath) return null;

		const override = this.plugin.settings.statsDbPathOverride?.trim();
		if (override) {
			return this._handleOverride(scanPath, override);
		}
		return this._discoverEnvironment(scanPath);
	}

	private async _validateScanPath(): Promise<string | null> {
		const configured = this.plugin.settings.koreaderScanPath?.trim();
		if (!configured) return null;
		const st = await this.fs.getNodeStats(configured);
		if (st.ok && st.value.isDirectory()) {
			return configured;
		}
		this.log.warn(
			"Configured scan path is not a usable directory:",
			configured,
		);
		return null;
	}

	private async _handleOverride(
		scanPath: string,
		override: string,
	): Promise<KOReaderEnvironment> {
		const explain = [`User override for stats DB is set: ${override}`];
		const exists = await this.fs.nodeFileExists(override);

		if (!exists) {
			explain.push("Error: Override path does not point to an existing file.");
		}

		return {
			scanPath,
			rootPath: null, // Root is unknown with an override
			statsDbPath: exists ? override : null,
			layout: "unknown",
			discoveredBy: "override",
			explain,
		};
	}

	private async _discoverEnvironment(
		scanPath: string,
	): Promise<KOReaderEnvironment> {
		const explain: string[] = [
			`Starting discovery from scan path: ${scanPath}`,
		];

		// 1) Fast-path
		{
			const res = await detectLayout(this.fs, scanPath);
			if (res) {
				explain.push(...res.explain);
				this.log.info(`Environment discovered via fast-path at scan path.`);
				return { scanPath, ...res, discoveredBy: res.layout, explain };
			}
		}
		explain.push("Fast-path: scan path is not a recognized KOReader root.");

		// 2) Walk-up
		let currentPath = path.resolve(scanPath);
		for (let i = 0; i < MAX_UP_DEPTH; i++) {
			explain.push(`Walk-up: probing at '${currentPath}'`);
			const res = await detectLayout(this.fs, currentPath);
			if (res) {
				explain.push(...res.explain);
				this.log.info(
					`Environment discovered via walk-up at '${currentPath}'.`,
				);
				return { scanPath, ...res, discoveredBy: res.layout, explain };
			}
			const parent = path.dirname(currentPath);
			if (parent === currentPath) break;
			currentPath = parent;
		}

		this.log.warn(
			"KOReader environment discovery failed for scan path:",
			scanPath,
		);
		explain.push("Walk-up failed: no layouts matched up to filesystem root.");
		return {
			scanPath,
			rootPath: null,
			statsDbPath: null,
			layout: "unknown",
			discoveredBy: "none",
			explain,
		};
	}
}
