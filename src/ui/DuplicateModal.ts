import { type App, ButtonComponent, Modal, Setting, setIcon } from "obsidian";
import type {
	DuplicateChoice,
	DuplicateMatch,
	IDuplicateHandlingModal,
} from "../types";

export class DuplicateHandlingModal
	extends Modal
	implements IDuplicateHandlingModal
{
	private choice: DuplicateChoice | null = "skip";
	private applyToAll = false;

	private resolvePromise:
		| ((value: { choice: DuplicateChoice | null; applyToAll: boolean }) => void)
		| null = null;

	private readonly boundKeydownHandler: (event: KeyboardEvent) => void;

	constructor(
		app: App,
		private match: DuplicateMatch,
		private message: string,
		private title = "Duplicate Highlights Found",
	) {
		super(app);
		this.boundKeydownHandler = this.handleKeydown.bind(this);
	}

	/* ------------------------------------------------------------------ */
	/*                             PUBLIC API                             */
	/* ------------------------------------------------------------------ */

	async openAndGetChoice(): Promise<{
		choice: DuplicateChoice | null;
		applyToAll: boolean;
	}> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	/* ------------------------------------------------------------------ */
	/*                                UI                                  */
	/* ------------------------------------------------------------------ */

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		// split into two calls; no chaining after .empty()
		contentEl.setAttr("role", "dialog");
		contentEl.setAttr("aria-labelledby", "modal-title");

		const container = contentEl.createDiv({
			cls: "duplicate-modal-container",
			attr: { "aria-modal": "true" },
		});

		/* ---------- header ---------- */
		const headerEl = container.createDiv("duplicate-modal-header");
		headerEl.createEl("h2", { text: this.title, attr: { id: "modal-title" } });
		headerEl.createEl("span", {
			cls: `duplicate-badge duplicate-badge-${this.match.matchType}`,
			text: this.getMatchTypeLabel(),
		});

		/* ---------- message + file ---------- */
		const msg = container.createDiv("duplicate-message");
		msg.createEl("p", { text: this.message });

		const pathLine = msg.createDiv("duplicate-file-path");
		setIcon(pathLine.createSpan(), "file-text");
		pathLine.createSpan({ text: this.match.file.path });

		/* ---------- stats ---------- */
		if (this.match.matchType !== "exact") {
			const stats = container.createDiv("duplicate-stats");
			const add = (icon: string, label: string, val: number) => {
				const s = stats.createDiv("stat-item");
				setIcon(s.createSpan("stat-icon"), icon);
				s.createSpan({ text: label });
				s.createSpan({ cls: "stat-value", text: val.toString() });
			};
			add("plus-circle", "New highlights:", this.match.newHighlights);
			add("edit", "Modified highlights:", this.match.modifiedHighlights);
		}

		/* ---------- toggle ---------- */
		const settingsEl = container.createDiv("duplicate-settings");
		new Setting(settingsEl)
			.setName("Apply to all remaining items")
			.setDesc("Use the same action for all subsequent duplicates")
			.addToggle((toggle) =>
				toggle.setValue(this.applyToAll).onChange((v) => {
					this.applyToAll = v; // keep local state in sync
				}),
			);

		/* ---------- buttons ---------- */
		this.createActionButtons(container, this.match.canMergeSafely);

		/* ---------- shortcuts help ---------- */
		const shortcuts = container.createDiv("duplicate-shortcuts");
		shortcuts.createSpan({ text: "Shortcuts: " });
		shortcuts.createEl("kbd", { text: "Enter" });
		shortcuts.createSpan({ text: " to Replace, " });
		shortcuts.createEl("kbd", { text: "Esc" });
		shortcuts.createSpan({ text: " to Skip" });

		contentEl.addEventListener("keydown", this.boundKeydownHandler);
		container.focus();
	}

	private createActionButtons(container: HTMLElement, canMergeSafely: boolean) {
		const wrap = container.createDiv("duplicate-buttons");

		const mk = (
			text: string,
			choice: DuplicateChoice,
			icon: string,
			opts: {
				warning?: boolean;
				disabled?: boolean;
				tooltip?: string;
				primary?: boolean;
			} = {},
		) => {
			const holder = wrap.createDiv("button-container");
			const btn = new ButtonComponent(holder)
				.setButtonText(text)
				.onClick(() => this.handleChoice(choice));

			const ic = btn.buttonEl.createSpan("button-icon");
			setIcon(ic, icon);
			ic.style.marginLeft = "4px";

			if (opts.warning) btn.setClass("mod-warning");
			if (opts.disabled) {
				btn.setDisabled(true);
				opts.tooltip && btn.setTooltip(opts.tooltip);
			}
			if (opts.primary) btn.setCta();
		};

		// --- Button Creation Logic ---

		const isExactMatch = this.match.matchType === "exact";

		// Button 1: Merge (Primary action if safe)
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

		mk("Merge", "merge", "git-merge", {
			primary: !isMergeDisabled, // CTA if it's the best option
			disabled: isMergeDisabled,
			tooltip: mergeTooltip,
		});

		// Button 2: Replace
		mk("Replace", "replace", "replace-all", {
			warning: true, // Overwriting is always a destructive action
			tooltip:
				"Overwrites the existing note in your vault with the new version from your device. Any local edits will be lost.",
		});

		// Button 3: Keep Both
		mk("Keep Both", "keep-both", "copy", {
			tooltip:
				"Ignores this match and creates a new, separate note for the incoming highlights.",
		});

		// Button 4: Skip
		mk("Skip", "skip", "x", {
			tooltip: "Skips importing this book for now.",
		});
	}

	/* ------------------------------------------------------------------ */
	/*                           EVENT HANDLERS                           */
	/* ------------------------------------------------------------------ */

	private handleChoice(choice: DuplicateChoice) {
		this.choice = choice;
		// this.applyToAll already reflects the toggle's latest state
		this.closeModal();
	}

	private handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") this.handleChoice("skip");
		else if (e.key === "Enter") this.handleChoice("replace");
	}

	private closeModal() {
		this.resolvePromise?.({ choice: this.choice, applyToAll: this.applyToAll });
		this.resolvePromise = null;
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		this.contentEl.removeEventListener("keydown", this.boundKeydownHandler);
		// ensure promise resolves if closed externally
		this.resolvePromise?.({ choice: "skip", applyToAll: false });
		this.resolvePromise = null;
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
