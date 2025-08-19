import { type App, ButtonComponent, Setting } from "obsidian";
import { ModalContentBuilder } from "src/ui/utils/modalComponents";
import type {
	DuplicateChoice,
	DuplicateHandlingSession,
	DuplicateMatch,
	IDuplicateHandlingModal,
} from "../types";
import { BaseModal } from "./BaseModal";

export class DuplicateHandlingModal
	extends BaseModal<{ choice: DuplicateChoice | null; applyToAll: boolean }>
	implements IDuplicateHandlingModal
{
	private choice: DuplicateChoice | null = "skip";
	private applyToAll = false;
	private mergeButton: ButtonComponent | null = null;

	constructor(
		app: App,
		private match: DuplicateMatch,
		private message: string,
		private session: DuplicateHandlingSession,
		private title = "Duplicate Highlights Found",
	) {
		super(app, {
			title: "", // avoid core header title to prevent duplication; we render our own H2
			ariaLabel: title,
			className: "duplicate-modal",
			enableEscape: true,
			enableEnter: true,
			focusOnOpen: true,
		});
		// preload toggle state from session
		this.applyToAll = this.session?.applyToAll ?? false;
	}

	/* ------------------------------------------------------------------ */
	/*                             PUBLIC API                             */
	/* ------------------------------------------------------------------ */

	async openAndGetChoice(): Promise<{
		choice: DuplicateChoice | null;
		applyToAll: boolean;
	}> {
		const res = await this.openAndAwaitResult();
		return res ?? { choice: this.choice, applyToAll: this.applyToAll };
	}

	/* ------------------------------------------------------------------ */
	/*                                UI                                  */
	/* ------------------------------------------------------------------ */

	protected renderContent(contentEl: HTMLElement): void {
		// Use the modal content element directly as the container to avoid an unnecessary nested wrapper
		const container = contentEl;
		container.addClass("duplicate-modal-container");
		container.setAttr("aria-labelledby", "modal-title");

		// Colored sidebar for at-a-glance status
		container.createDiv({
			cls: "duplicate-modal-sidebar",
			attr: { "data-type": this.match.matchType },
		});

		// main content column
		const main = container.createDiv();

		/* ---------- header ---------- */
		const builder = new ModalContentBuilder(main);
		builder.addStatusHeader({
			title: this.title,
			badge: { type: this.match.matchType, label: this.getMatchTypeLabel() },
			icon: undefined,
			headingLevel: 2,
		});
		// ensure aria points to our header
		const h2 = main.querySelector("h2");
		if (h2) h2.setAttr("id", "modal-title");

		/* ---------- message + file ---------- */
		const msg = main.createDiv("duplicate-message");
		msg.createEl("p", { text: this.message });
		new ModalContentBuilder(msg).addFilePath(this.match.file.path, () =>
			this.app.workspace.openLinkText(this.match.file.path, "", false),
		);

		// helpers
		const helperContainer = main.createDiv({ cls: "duplicate-modal-helpers" });
		new ButtonComponent(helperContainer)
			.setButtonText("Open existing note")
			.onClick(() =>
				this.app.workspace.openLinkText(this.match.file.path, "", false),
			);

		/* ---------- stats ---------- */
		if (this.match.matchType !== "exact") {
			const items: Array<{ text: string; type?: "add" | "modify" | "info" }> =
				[];
			if (this.match.newHighlights > 0) {
				items.push({
					text: `This import will add ${this.match.newHighlights} new highlight(s).`,
					type: "add",
				});
			}
			if (this.match.modifiedHighlights > 0) {
				items.push({
					text: `This import will update ${this.match.modifiedHighlights} existing highlight(s).`,
					type: "modify",
				});
			}
			new ModalContentBuilder(main).addStatsList("Summary of Changes", items);
		}

		/* ---------- toggle ---------- */
		const settingsEl = main.createDiv("duplicate-settings");
		new Setting(settingsEl)
			.setName("Apply to all remaining files in this import")
			.setDesc(
				"Use the same action for all subsequent duplicates during this run.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.applyToAll).onChange((v) => {
					this.applyToAll = v; // keep local state in sync
				}),
			);

		/* ---------- buttons ---------- */
		this.createActionButtons(main, this.match.canMergeSafely);

		/* ---------- shortcuts help ---------- */
		const shortcuts = main.createDiv("duplicate-shortcuts");
		shortcuts.appendText("Shortcuts: "); // Use appendText for plain text nodes

		if (this.mergeButton && !this.mergeButton.buttonEl.disabled) {
			shortcuts.createEl("kbd", { text: "Enter" });
			shortcuts.appendText(" to Merge, ");
			shortcuts.createEl("kbd", { text: "Esc" });
			shortcuts.appendText(" to Skip");
		} else {
			shortcuts.createEl("kbd", { text: "Esc" });
			shortcuts.appendText(" to Skip");
		}
	}

	private createActionButtons(container: HTMLElement, canMergeSafely: boolean) {
		const buttonContainer = container.createDiv("duplicate-buttons");

		const mk = (
			parent: HTMLElement,
			text: string,
			choice: DuplicateChoice,
			icon: string,
			opts: {
				tooltip?: string;
				primary?: boolean;
				warning?: boolean;
				disabled?: boolean;
			} = {},
		) => {
			const btn = new ButtonComponent(parent)
				.setIcon(icon) // set icon first; Obsidian may clear text when setting icon
				.setButtonText(text)
				.onClick(() => this.handleChoice(choice));
			btn.buttonEl.addClass("btn");
			btn.buttonEl.addClass("koreader-modal-action-button");
			if (opts.primary) btn.buttonEl.addClass("cta");
			if (opts.warning) btn.buttonEl.addClass("warn");
			if (opts.disabled) btn.setDisabled(true);
			if (opts.tooltip) btn.setTooltip(opts.tooltip, { placement: "top" });
			return btn;
		};

		// --- Button Creation Logic ---
		const isExactMatch = this.match.matchType === "exact";
		const isMergeDisabled = isExactMatch || !canMergeSafely;
		let mergeTooltip =
			"Performs a 3-way merge, safely combining your local edits with new highlights from your device.";
		if (isExactMatch) {
			mergeTooltip =
				"Merge is disabled because the content is identical. There is nothing to merge.";
		} else if (!canMergeSafely) {
			mergeTooltip =
				"Merge is disabled. A snapshot of the previously imported version was not found, which is required for a safe 3-way merge.";
		}

		// Append all buttons directly to the buttonContainer for a 4-column layout
		this.mergeButton = mk(buttonContainer, "Merge", "merge", "git-merge", {
			primary: !isMergeDisabled,
			disabled: isMergeDisabled,
			tooltip: mergeTooltip,
		});
		mk(buttonContainer, "Replace", "replace", "replace-all", {
			warning: true,
			tooltip:
				"Overwrites the existing note in your vault with the new version from your device. Any local edits will be lost.",
		});

		mk(buttonContainer, "Keep Both", "keep-both", "copy", {
			tooltip:
				"Ignores this match and creates a new, separate note for the incoming highlights.",
		});
		mk(buttonContainer, "Skip", "skip", "x", {
			tooltip: "Skips importing this book for now.",
		});
	}

	private handleChoice(choice: DuplicateChoice) {
		this.choice = choice;
		if (this.applyToAll && this.session) {
			this.session.applyToAll = true;
			this.session.choice = choice;
		}
		this.resolveAndClose({ choice: this.choice, applyToAll: this.applyToAll });
	}

	protected registerShortcuts(): void {
		super.registerShortcuts();
		// Additional shortcuts
		this.registerShortcut(["Mod"], "m", () => this.handleChoice("merge"));
		this.registerShortcut(["Mod"], "r", () => this.handleChoice("replace"));
		this.registerShortcut(["Mod"], "k", () => this.handleChoice("keep-both"));
		this.registerShortcut(["Mod"], "s", () => this.handleChoice("skip"));
		this.registerShortcut([], "Escape", () => this.handleChoice("skip"));
	}

	protected getFocusElement(): HTMLElement | null {
		return this.mergeButton?.buttonEl ?? null;
	}

	/* ------------------------------------------------------------------ */
	/*                             helpers                                */
	/* ------------------------------------------------------------------ */

	private getMatchTypeLabel(): string {
		return {
			exact: "Exact Match",
			updated: "Updated Content",
			divergent: "Content Differs",
		}[this.match.matchType];
	}
}
