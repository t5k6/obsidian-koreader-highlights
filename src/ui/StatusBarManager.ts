import { type App, Component, Notice, setIcon, type TFile } from "obsidian";
import type KoreaderImporterPlugin from "src/core/KoreaderImporterPlugin";
import type { BookRefreshOrchestrator } from "src/services/BookRefreshOrchestrator";
import type { LocalIndexService } from "src/services/vault/LocalIndexService";
import { runPluginAction } from "src/utils/actionUtils";

/**
 * Manages the status bar item to refresh the current KOReader note.
 * The item is only visible when the active file is a tracked KOReader note.
 */
export class StatusBarManager extends Component {
	private statusBarItem!: HTMLElement;

	constructor(
		private readonly app: App,
		private readonly plugin: KoreaderImporterPlugin,
		private readonly localIndex: LocalIndexService,
		private readonly orchestrator: BookRefreshOrchestrator,
	) {
		super();
	}

	override onload(): void {
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
		try {
			const key = await this.localIndex.findKeyByVaultPath(file.path);
			return !!key;
		} catch {
			return false;
		}
	}

	private async handleStatusBarClick(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;

		let resultMessage = "";
		await runPluginAction(
			async () => {
				const changed = await this.orchestrator.refreshNote(file);
				resultMessage = changed
					? "KOReader highlights refreshed for this book."
					: "No new highlights found for this book.";
			},
			{
				button: {
					// Minimal Button-like impl for runPluginAction
					setDisabled: (disabled: boolean) => {
						this.statusBarItem.toggleClass("is-disabled", disabled);
						this.statusBarItem.style.pointerEvents = disabled ? "none" : "auto";
					},
					setButtonText: (text: string) => {
						// Reflect progress via aria-label only
						this.statusBarItem.ariaLabel =
							text || "Refresh KOReader highlights for this note";
					},
				} as any,
				inProgressText: "Refreshing…",
				completedText: "",
			},
		);

		if (resultMessage) new Notice(resultMessage, 5000);
	}
}
