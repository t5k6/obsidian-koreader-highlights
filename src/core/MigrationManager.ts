import { type Plugin, TFile, TFolder, type Vault } from "obsidian";
import type { LoggingService } from "src/services/LoggingService";

// --- Helper Functions ---

/**
 * Compares two semantic versions.
 * Returns:
 *   1 if version a > version b
 *   0 if version a == version b
 *  -1 if version a < version b
 * @param a The first version string (e.g., "1.2.3-beta.1").
 * @param b The second version string.
 * @returns A number indicating the comparison result.
 */
function cmpVer(a: string, b: string): number {
	const [am, ap] = a.split("-", 2); // main & prerelease
	const [bm, bp] = b.split("-", 2);

	const an = am.split(".").map((n) => parseInt(n, 10) || 0);
	const bn = bm.split(".").map((n) => parseInt(n, 10) || 0);

	for (let i = 0; i < 3; i++) {
		if (an[i] > bn[i]) return 1;
		if (an[i] < bn[i]) return -1;
	}
	/* numeric parts equal – handle prerelease tag */
	if (ap && !bp) return -1; // 1.0.0-alpha  <  1.0.0
	if (!ap && bp) return 1;
	if (ap && bp) return ap > bp ? 1 : ap < bp ? -1 : 0;
	return 0;
}

// --- Migration Manager ---

interface PluginData {
	lastMigratedTo?: string; // undefined on first install
}

type MigrationFn = () => Promise<void>;

export class MigrationManager {
	private readonly log;
	private lastDone = "0.0.0";
	private vault: Vault;
	private migrations: Record<string, MigrationFn>;

	constructor(
		private plugin: Plugin,
		private loggingService: LoggingService,
	) {
		this.vault = this.plugin.app.vault;
		this.log = this.loggingService.scoped("MigrationManager");
		// Define migrations here, binding them to the class instance
		this.migrations = {
			"1.2.0": this.cleanupOldLogFiles.bind(this),
			// "1.3.0": this.anotherMigration.bind(this),
		};
	}

	public async run(): Promise<void> {
		const data: PluginData = (await this.plugin.loadData()) ?? {};
		this.lastDone = data.lastMigratedTo ?? "0.0.0";

		const current = this.plugin.manifest.version;

		const migrationVersions = Object.keys(this.migrations).sort(cmpVer);

		for (const version of migrationVersions) {
			if (
				cmpVer(version, this.lastDone) === 1 && // version > lastDone
				cmpVer(version, current) <= 0 // version <= current
			) {
				this.log.info(`Running migration for version -> ${version}`);
				try {
					// eslint-disable-next-line no-await-in-loop
					await this.migrations[version]();
					this.lastDone = version; // Mark as done only on success
				} catch (error) {
					this.log.error(
						`Migration for ${version} failed. Halting further migrations.`,
						error,
					);
					break; // Stop migrations if one fails
				}
			}
		}

		data.lastMigratedTo = this.lastDone;
		await this.plugin.saveData(data);
	}

	/* ---------------- Migration Implementations ------------------- */

	private async cleanupOldLogFiles(): Promise<void> {
		const LEGACY_DIRS = ["koreader/logs", "koreader_importer_logs"];
		let removed = 0;

		for (const dir of LEGACY_DIRS) {
			const folder = this.vault.getAbstractFileByPath(dir);
			if (!(folder instanceof TFolder)) continue;

			const victims = folder.children.filter(
				(c): c is TFile =>
					c instanceof TFile && c.name.startsWith("koreader-importer_"),
			);

			await Promise.all(
				victims.map(async (f) => {
					try {
						await this.vault.delete(f);
						removed++;
					} catch (e) {
						this.log.warn(`Could not delete old log ${f.path}`, e);
					}
				}),
			);
		}
		if (removed > 0) {
			this.log.info(`Removed ${removed} old log files during 1.2.0 migration.`);
		}
	}
}
