import { posix as posixPath } from "node:path";
import { type App, parseYaml, stringifyYaml, TFile, TFolder } from "obsidian";
import { DIContainer } from "src/core/DIContainer";
import { registerServices } from "src/core/registerServices";
import { DEFAULT_SETTINGS } from "src/core/settingsSchema";
import { APP_TOKEN, PLUGIN_TOKEN, VAULT_TOKEN } from "src/core/tokens";
import { CacheManager } from "src/lib/cache";
import type { ConcurrentDatabase } from "src/lib/concurrency";
import { err, ok } from "src/lib/core/result";
import { toVaultPath as toVaultPathUtil } from "src/lib/pathing";
import { CapabilityManager } from "src/services/CapabilityManager";
import { CommandManager } from "src/services/command/CommandManager";
import { DeviceService } from "src/services/device/DeviceService";
import { FileSystemService } from "src/services/FileSystemService";
import { ImportService } from "src/services/import/ImportService";
import { LoggingService } from "src/services/LoggingService";
import { FrontmatterService } from "src/services/parsing/FrontmatterService";
import { TemplateManager } from "src/services/parsing/TemplateManager";
import { SqlJsManager } from "src/services/SqlJsManager";
import { PromptService } from "src/services/ui/PromptService";
import { DuplicateFinder } from "src/services/vault/DuplicateFinder";
import { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import { IndexDatabase } from "src/services/vault/index/IndexDatabase";
import { MergeHandler } from "src/services/vault/MergeHandler";
import { NotePersistenceService } from "src/services/vault/NotePersistenceService";
import type { KoreaderHighlightImporterSettings } from "src/types";
import { type Mock, vi } from "vitest";

type MockPlugin = {
	app: App;
	manifest: { id: string };
	registerEvent: Mock;
	settings: KoreaderHighlightImporterSettings;
	addSettingTab: Mock;
	addCommand: Mock;
	loadData: Mock;
	saveData: Mock;
};

export class TestHarness {
	public di!: DIContainer;
	public app!: ReturnType<typeof this.createAppMock>;
	public vault!: ReturnType<typeof this.createVaultMock>;
	public fs!: ReturnType<typeof this.createFsMock>;
	public plugin!: MockPlugin;
	public logging!: ReturnType<typeof this.createLoggerMock>;
	public cacheManager!: ReturnType<typeof this.createCacheManagerMock>;
	public sqlJsManager!: ReturnType<typeof this.createSqlJsManagerMock>;
	public capabilities!: ReturnType<typeof this.createCapabilitiesMock>;
	public indexDb!: ReturnType<typeof this.createIndexDatabaseMock>;
	public device!: ReturnType<typeof this.createDeviceServiceMock>;
	public templateManager!: ReturnType<typeof this.createTemplateManagerMock>;

	// Service properties
	public fmService!: FrontmatterService;
	public notePersistence!: NotePersistenceService;
	public indexCoordinator!: IndexCoordinator;
	public duplicateFinder!: DuplicateFinder;
	public mergeHandler!: MergeHandler;
	public importService!: ImportService;
	public commandManager!: CommandManager;

	private vaultFiles = new Map<string, string>();
	private fileStats = new Map<string, { mtime: number; size: number }>();
	private settings: KoreaderHighlightImporterSettings = { ...DEFAULT_SETTINGS };
	private mockDb!: ReturnType<typeof this.createMockDbObject>;

	constructor() {
		this.reset();
	}

	public reset(): void {
		this.vaultFiles.clear();
		this.fileStats.clear();
		this.settings = { ...DEFAULT_SETTINGS };
		this.vault = this.createVaultMock();
		this.app = this.createAppMock();
		this.plugin = this.createPluginMock();
		this.logging = this.createLoggerMock();
		this.fs = this.createFsMock();
		this.cacheManager = this.createCacheManagerMock();
		this.mockDb = this.createMockDbObject();
		this.sqlJsManager = this.createSqlJsManagerMock();
		this.capabilities = this.createCapabilitiesMock();
		this.indexDb = this.createIndexDatabaseMock();
		this.device = this.createDeviceServiceMock();
		this.templateManager = this.createTemplateManagerMock();
		this.di = new DIContainer(this.logging);

		this.registerDependencies();
		this.resolveAllServices();
	}

	private registerDependencies(): void {
		this.di.registerValue(APP_TOKEN, this.app);
		this.di.registerValue(VAULT_TOKEN, this.vault);
		this.di.registerValue(PLUGIN_TOKEN, this.plugin as any);
		this.di.registerValue(LoggingService, this.logging);
		this.di.registerValue(FileSystemService, this.fs);
		this.di.registerValue(DeviceService, this.device as any);
		this.di.registerValue(CacheManager, this.cacheManager);
		this.di.registerValue(SqlJsManager, this.sqlJsManager);
		this.di.registerValue(CapabilityManager, this.capabilities);
		this.di.registerValue(IndexDatabase, this.indexDb as any);
		this.di.registerValue(TemplateManager, this.templateManager as any);

		registerServices(this.di, this.plugin as any, this.app);
	}

	private resolveAllServices(): void {
		this.fmService = this.di.resolve(FrontmatterService);
		this.notePersistence = this.di.resolve(NotePersistenceService);
		this.indexCoordinator = this.di.resolve(IndexCoordinator);
		this.duplicateFinder = this.di.resolve(DuplicateFinder);
		this.mergeHandler = this.di.resolve(MergeHandler);
		this.importService = this.di.resolve(ImportService);
		this.commandManager = this.di.resolve(CommandManager);
	}

	public withFile(
		path: string,
		content: string,
		stats?: Partial<{ mtime: number; size: number }>,
	): this {
		const normPath = toVaultPathUtil(path);
		this.vaultFiles.set(normPath, content);

		const defaultStats = { mtime: Date.now(), size: content.length };
		// Merge provided stats over defaults
		this.fileStats.set(normPath, { ...defaultStats, ...stats });

		return this;
	}

	public withFrontmatter(
		path: string,
		fm: Record<string, any>,
		body = "",
	): this {
		const yaml = stringifyYaml(fm);
		return this.withFile(path, `---\n${yaml}---\n\n${body}`);
	}

	public withSdrFile(
		sdrRelativePath: string,
		luaContent: string,
		bookContent?: string,
	): this {
		this.device.addSdrFile(sdrRelativePath, luaContent);
		if (bookContent !== undefined) {
			this.withFile(sdrRelativePath, bookContent);
		}
		return this;
	}

	public withSettings(
		partial: Partial<KoreaderHighlightImporterSettings>,
	): this {
		Object.assign(this.settings, partial);
		this.di.notifySettingsChanged(this.settings, this.settings);
		return this;
	}

	public buildService<T>(
		ctor: new (...args: any[]) => T,
		overrides?: Record<string, any>,
	): T {
		const testContainer = new DIContainer(this.logging);
		testContainer.registerValue(APP_TOKEN, this.app);
		testContainer.registerValue(VAULT_TOKEN, this.vault);
		testContainer.registerValue(PLUGIN_TOKEN, this.plugin as any);
		testContainer.registerValue(LoggingService, this.logging);
		testContainer.registerValue(FileSystemService, this.fs);
		testContainer.registerValue(DeviceService, this.device as any);
		testContainer.registerValue(CacheManager, this.cacheManager);
		testContainer.registerValue(SqlJsManager, this.sqlJsManager);
		testContainer.registerValue(CapabilityManager, this.capabilities);
		testContainer.registerValue(IndexDatabase, this.indexDb as any);
		testContainer.registerValue(TemplateManager, this.templateManager as any);
		registerServices(testContainer, this.plugin as any, this.app);

		if (overrides) {
			if (overrides.promptService) {
				testContainer.registerValue(PromptService, overrides.promptService);
			}
		}

		return testContainer.resolve(ctor);
	}

	public setIndexDbState(
		state: "persistent" | "in_memory" | "unavailable",
	): void {
		(this.indexDb as any).__setState(state);
	}

	public createFile(path: string): TFile {
		const normPath = toVaultPathUtil(path);
		if (!this.vaultFiles.has(normPath)) {
			this.withFile(normPath, "");
		}
		const stat = this.fileStats.get(normPath)!;
		const name = posixPath.basename(normPath);
		const ext = posixPath.extname(normPath).slice(1);

		const file = new TFile();
		file.path = normPath;
		Object.assign(file, {
			name,
			basename: posixPath.basename(normPath, `.${ext}`),
			extension: ext,
			stat: { ...stat },
			vault: this.vault,
		});
		return file;
	}

	public externallyModifyFile(path: string, newContent?: string): void {
		const normPath = toVaultPathUtil(path);
		if (newContent !== undefined) {
			this.vaultFiles.set(normPath, newContent);
		} else if (!this.vaultFiles.has(normPath)) {
			this.vaultFiles.set(normPath, "");
		}
		const finalContent = this.vaultFiles.get(normPath)!;
		const oldStat = this.fileStats.get(normPath) ?? {
			mtime: Date.now() - 1000,
			size: 0,
		};
		this.fileStats.set(normPath, {
			mtime: oldStat.mtime + 1,
			size: finalContent.length,
		});
	}

	public expectFileContent(path: string): string {
		const content = this.vaultFiles.get(toVaultPathUtil(path));
		expect(
			content,
			`File "${path}" was not found in the harness vault.`,
		).toBeDefined();
		return content!;
	}

	public expectFrontmatter(path: string): Record<string, any> {
		const content = this.expectFileContent(path);
		const match = content.match(/^---\n([\s\S]+?)\n---/);
		expect(match, `File "${path}" does not contain frontmatter.`).toBeTruthy();
		return parseYaml(match![1]) ?? {};
	}

	private createVaultMock() {
		return {
			read: vi.fn(async (file: TFile) => this.vaultFiles.get(file.path) ?? ""),
			modify: vi.fn(async (file: TFile, content: string) => {
				const path = toVaultPathUtil(file.path);
				this.vaultFiles.set(path, content);
				this.fileStats.get(path)!.mtime = Date.now();
			}),
			getAbstractFileByPath: vi.fn((p: string) => {
				const path = toVaultPathUtil(p);
				if (this.vaultFiles.has(path)) return this.createFile(path);
				const isFolder = Array.from(this.vaultFiles.keys()).some((key) =>
					key.startsWith(`${path}/`),
				);
				if (isFolder) {
					const folder = new TFolder();
					folder.path = path;
					return folder;
				}
				return null;
			}),
			getRoot: vi.fn(() => {
				const folder = new TFolder();
				folder.path = "";
				return folder;
			}),
			on: vi.fn(() => ({ off: vi.fn() })),
			configDir: ".obsidian",
			adapter: {
				exists: vi.fn(async (p: string) => this.vaultFiles.has(p)),
				write: vi.fn(),
				remove: vi.fn(),
				rename: vi.fn(),
				list: vi.fn(async () => ({ files: [], folders: [] })),
				append: vi.fn(),
			},
		} as any;
	}

	private createAppMock() {
		return {
			vault: this.vault,
			metadataCache: {
				getFileCache: vi.fn((file: TFile) => {
					const content = this.vaultFiles.get(file.path);
					if (!content) return null;
					const match = content.match(/^---\n([\s\S]+?)\n---/);
					if (!match) return null;
					return { frontmatter: parseYaml(match![1]) ?? {} };
				}),
				on: vi.fn(() => ({ off: vi.fn() })),
			},
			workspace: { on: vi.fn(() => ({ off: vi.fn() })) },
			fileManager: {
				processFrontMatter: vi.fn(async (file, cb) => {
					const content = await this.vault.read(file);
					const doc = this.fmService.parseContent(content);
					cb(doc.frontmatter);
					const newContent = this.fmService.reconstructFileContent(
						doc.frontmatter,
						doc.body,
					);
					await this.vault.modify(file, newContent);
				}),
			},
		} as any as App;
	}

	private createPluginMock(): MockPlugin {
		return {
			app: this.app,
			manifest: { id: "obsidian-koreader-highlights" },
			settings: this.settings,
			registerEvent: vi.fn(),
			addSettingTab: vi.fn(),
			addCommand: vi.fn(),
			loadData: vi.fn(),
			saveData: vi.fn(),
		};
	}

	private createFsMock() {
		const fsMock = {
			getPluginDataDir: vi.fn(() =>
				toVaultPathUtil(`.obsidian/plugins/${this.plugin.manifest.id}`),
			),
			joinPluginDataPath: vi.fn((...segments: string[]) =>
				toVaultPathUtil(posixPath.join(fsMock.getPluginDataDir(), ...segments)),
			),
			joinVaultPath: vi.fn((...s: string[]) =>
				toVaultPathUtil(posixPath.join(...s)),
			),
			ensureVaultFolder: vi.fn(async (_p: string) => ok(undefined)),
			vaultExists: vi.fn(async (p: string) =>
				ok(this.vaultFiles.has(toVaultPathUtil(p))),
			),
			writeVaultTextAtomic: vi.fn(async (p: string, c: string) => {
				this.withFile(p, c);
				return ok(undefined);
			}),
			readVaultText: vi.fn(async (p: string) => {
				const path = toVaultPathUtil(p);
				const content = this.vaultFiles.get(path);
				return content !== undefined
					? ok(content)
					: err({ kind: "NotFound", path });
			}),
			removeVaultPath: vi.fn(async (p: string) => {
				const path = toVaultPathUtil(p);
				this.vaultFiles.delete(path);
				this.fileStats.delete(path);
				return ok(undefined);
			}),
			renameVaultPathAtomic: vi.fn(async (from: string, to: string) => {
				const fromPath = toVaultPathUtil(from);
				const toPath = toVaultPathUtil(to);
				if (this.vaultFiles.has(fromPath)) {
					this.vaultFiles.set(toPath, this.vaultFiles.get(fromPath)!);
					this.vaultFiles.delete(fromPath);
				}
				if (this.fileStats.has(fromPath)) {
					this.fileStats.set(toPath, this.fileStats.get(fromPath)!);
					this.fileStats.delete(fromPath);
				}
				return ok(undefined);
			}),
			getFilesInFolder: vi.fn(async (folder: string | TFolder) => {
				const rootPath =
					(typeof folder === "string" ? folder : folder.path) || "";
				const files = Array.from(this.vaultFiles.keys())
					.filter(
						(p) =>
							p.startsWith(rootPath ? `${rootPath}/` : "") && p !== rootPath,
					)
					.map((p) => this.createFile(p));
				return { files, aborted: false };
			}),
			readVaultTextWithRetry: vi.fn((f: TFile) => fsMock.readVaultText(f.path)),
			modifyVaultFileWithRetry: vi.fn((f: TFile, c: string) => {
				this.withFile(f.path, c);
				return ok(undefined);
			}),
			writeProbe: vi.fn(async (_path: string) => true),
			ensureParentDirectory: vi.fn(async (_p: string) => ok(undefined)),
		};
		return fsMock as any;
	}

	private createDeviceServiceMock() {
		const sdrFiles = new Map<string, string>();
		let scanPath = "/koreader";
		return {
			addSdrFile: vi.fn((path: string, content: string) =>
				sdrFiles.set(path, content),
			),
			setScanPath: vi.fn((path: string) => {
				scanPath = path;
			}),
			getActiveScanPath: vi.fn(async () => scanPath),
			findSdrDirectoriesWithMetadata: vi.fn(async () =>
				Array.from(sdrFiles.keys()).map((sdrPath) =>
					posixPath.join(scanPath, sdrPath, "metadata.epub.lua"),
				),
			),
			readMetadataFileContent: vi.fn(async (sdrDir: string) => {
				const sdrRelativePath = posixPath.relative(scanPath, sdrDir);
				return sdrFiles.get(sdrRelativePath) ?? null;
			}),
			findBookStatistics: vi.fn(async () => null),
			clearCache: vi.fn(() => sdrFiles.clear()),
			whenReady: vi.fn().mockResolvedValue(undefined),
		};
	}

	private createTemplateManagerMock() {
		return {
			getCompiledTemplateResult: vi.fn(
				async () => (data: any) => JSON.stringify(data),
			),
			renderAnnotations: vi.fn(() => "RENDERED_ANNOTATIONS"),
		};
	}

	private createLoggerMock() {
		const info = vi.fn();
		const warn = vi.fn();
		const error = vi.fn();
		const scopedLogger = { info, warn, error };
		const logger = {
			info,
			warn,
			error,
			scoped: vi.fn(() => scopedLogger),
			onSettingsChanged: vi.fn(),
			dispose: vi.fn(),
			setFileSystem: vi.fn(),
		};
		return logger as any;
	}

	private createCacheManagerMock() {
		return {
			createMap: vi.fn(() => new Map<any, any>()),
			createLru: vi.fn(() => new Map<any, any>()),
			clear: vi.fn(),
		} as any;
	}

	private createMockDbObject() {
		return {
			run: vi.fn(),
			exec: vi.fn(() => []),
			close: vi.fn(),
			prepare: vi.fn(() => ({
				bind: vi.fn(),
				step: vi.fn(() => false),
				getAsObject: vi.fn(() => ({})),
				free: vi.fn(),
			})),
			getRowsModified: vi.fn(() => 1),
		};
	}

	private createSqlJsManagerMock() {
		return {
			openDatabase: vi
				.fn()
				.mockResolvedValue(err({ kind: "DbOpenFailed", path: "mock.db" })),
			createInMemoryDatabase: vi.fn().mockResolvedValue(this.mockDb),
			applySchema: vi.fn(),
		} as any;
	}

	private createCapabilitiesMock() {
		return { ensure: vi.fn(async () => true), reportOutcome: vi.fn() } as any;
	}

	private createIndexDatabaseMock() {
		type DbState = "persistent" | "in_memory" | "unavailable";
		let state: DbState = "persistent";
		let concurrentDb: ConcurrentDatabase | null = null;

		return {
			whenReady: vi.fn().mockResolvedValue(undefined),
			whenFullyReady: vi.fn().mockResolvedValue(undefined),
			getConcurrent: vi.fn(() => {
				if (!concurrentDb) {
					concurrentDb = {
						execute: vi.fn(async (cb) => cb(this.mockDb)),
						writeTx: vi.fn(async (cb) => cb(this.mockDb)),
					} as any;
				}
				return concurrentDb;
			}),
			getState: vi.fn(() => state),
			isReady: vi.fn(() => true),
			isRebuilding: vi.fn(() => false),
			flush: vi.fn().mockResolvedValue(undefined),
			startBackgroundRebuild: vi.fn().mockResolvedValue(undefined),
			__setState: (s: DbState) => {
				state = s;
			},
			__setConcurrentDatabase: (cdb: ConcurrentDatabase) => {
				concurrentDb = cdb;
			},
		} as any;
	}
}

export const harness = new TestHarness();
