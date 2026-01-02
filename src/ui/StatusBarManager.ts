import { type App, Component, Notice, setIcon, type TFile } from "obsidian";

import { CacheManager } from "src/lib/cache/CacheManager";
import type { IterableCache } from "src/lib/cache/types";
import { isErr } from "src/lib/core/result";
import type KoreaderImporterPlugin from "src/main";
import type { CommandManager } from "src/services/command/CommandManager";
import type { IndexCoordinator } from "src/services/vault/index/IndexCoordinator";
import { runAsyncAction } from "src/ui/utils/actionUtils";

/**
 * Manages the status bar item to refresh the current KOReader note.
 * The item is only visible when the active file is a tracked KOReader note.
 */

export class StatusBarManager extends Component {
	private statusBarItem!: HTMLElement;
	private refreshableCache:
		| IterableCache<string, boolean>
		| Map<string, boolean>
		| null = null;

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly localIndex: IndexCoordinator,
		private readonly commandManager: CommandManager,
	) {
		super();
	}

	override onload(): void {
		// Initialize LRU cache for refreshable status (max 500 entries to prevent unbounded growth)
		const diContainer = (this.plugin as unknown as { diContainer?: any })
			.diContainer;
		const cacheManager = diContainer?.resolve?.(CacheManager) as
			| CacheManager
			| undefined;
		if (cacheManager) {
			this.refreshableCache = cacheManager.createLru(
				"statusBarRefreshable",
				500,
			);
		} else {
			// Fallback to a simple map if CacheManager unavailable
			this.refreshableCache = new Map<string, boolean>();
		}

		// Create status bar item via plugin API (correct surface for Obsidian)
		this.statusBarItem = this.plugin.addStatusBarItem();
		this.statusBarItem.addClass("koreader-statusbar-item", "mod-clickable");
		setIcon(this.statusBarItem, "refresh-cw");
		this.statusBarItem.ariaLabel = "Refresh KOReader highlights for this note";
		this.statusBarItem.style.display = "none"; // hidden by default

		this.registerDomEvent(this.statusBarItem, "click", () =>
			this.handleStatusBarClick(),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.updateVisibility(),
			),
		);

		// Initial state
		this.updateVisibility();
	}

	override onunload(): void {
		this.statusBarItem?.remove();
	}

	private async updateVisibility(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (file && (await this.isRefreshable(file))) {
			this.statusBarItem.style.display = "";
		} else {
			this.statusBarItem.style.display = "none";
		}
	}

	private async isRefreshable(file: TFile): Promise<boolean> {
		if (file.extension !== "md") return false;

		// Check cache first to avoid expensive async calls
		if (this.refreshableCache) {
			const cachedResult = this.refreshableCache.get(file.path);
			if (cachedResult !== undefined && cachedResult !== null) {
				return cachedResult as boolean;
			}
		}

		// Not in cache, compute and store
		try {
			const key = await this.localIndex.findKeyByVaultPath(file.path);
			const result = !!key;
			this.refreshableCache?.set(file.path, result);
			return result;
		} catch {
			this.refreshableCache?.set(file.path, false);
			return false;
		}
	}

	/**
	 * Clear the refreshable cache when the index is updated or plugin data changes
	 */
	public clearCache(): void {
		this.refreshableCache?.clear();
	}

	private async handleStatusBarClick(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;

		let resultMessage = "";
		await runAsyncAction(
			this.statusBarItem,
			async () => {
				const res = await this.commandManager.executeRefreshCurrentNote(file);
				if (isErr(res)) {
					resultMessage = "Refresh failed. See console for details.";
					return;
				}
				const changed = !!res.value?.changed;
				resultMessage = changed
					? "KOReader highlights refreshed for this book."
					: "No new highlights found for this book.";
			},
			{
				inProgress: "Refreshing…",
				original: "Refresh KOReader highlights for this note",
			},
		);

		if (resultMessage) new Notice(resultMessage, 5000);
	}
}
