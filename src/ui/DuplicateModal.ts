import type { App } from "obsidian";
import {
	createApplyToAllToggle,
	ModalContentBuilder,
} from "src/ui/utils/modalComponents";
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

	constructor(
		app: App,
		private match: DuplicateMatch,
		private message: string,
		private session: DuplicateHandlingSession,
		private title = "Duplicate Highlights Found",
	) {
		super(app, {
			title: "",
			ariaLabel: title,
			className: "duplicate-modal",
			enableEscape: true,
			enableEnter: true,
			focusOnOpen: true,
		});
		// The session is the source of truth for the toggle's initial state.
	}

	async openAndGetChoice(): Promise<{
		choice: DuplicateChoice | null;
		applyToAll: boolean;
	}> {
		const res = await this.openAndAwaitResult();
		// If user cancels (Escape), res is null. Map this to a 'skip' choice.
		if (res === null) {
			return {
				choice: "skip",
				applyToAll: this.session.applyToAll,
			};
		}
		return res;
	}

	protected renderContent(contentEl: HTMLElement): void {
		const container = contentEl;
		container.addClass("duplicate-modal-container");
		container.setAttr("aria-labelledby", "modal-title");

		container.createDiv({
			cls: "duplicate-modal-sidebar",
			attr: { "data-type": this.match.matchType },
		});

		const main = container.createDiv();

		const builder = new ModalContentBuilder(main);
		builder.addStatusHeader({
			title: this.title,
			badge: { type: this.match.matchType, label: this.getMatchTypeLabel() },
			headingLevel: 2,
		});
		const h2 = main.querySelector("h2");
		if (h2) h2.setAttr("id", "modal-title");

		const msg = main.createDiv("duplicate-message");
		msg.createEl("p", { text: this.message });
		builder.addFilePath(this.match.file.path, () =>
			this.app.workspace.openLinkText(this.match.file.path, "", false),
		);

		if (this.match.matchType !== "exact") {
			const items: Array<{ text: string; type?: "add" | "modify" | "info" }> =
				[];
			if (this.match.newHighlights > 0)
				items.push({
					text: `This import will add ${this.match.newHighlights} new highlight(s).`,
					type: "add",
				});
			if (this.match.modifiedHighlights > 0)
				items.push({
					text: `This import will update ${this.match.modifiedHighlights} existing highlight(s).`,
					type: "modify",
				});
			builder.addStatsList("Summary of Changes", items);
		}

		const settingsEl = main.createDiv("duplicate-settings");
		createApplyToAllToggle(settingsEl, this.session);

		const isExactMatch = this.match.matchType === "exact";
		const isMergeDisabled = isExactMatch || !this.match.canMergeSafely;
		let mergeTooltip =
			"Performs a 3-way merge, combining your local edits with new highlights.";
		if (isExactMatch)
			mergeTooltip = "Merge is disabled because the content is identical.";
		else if (!this.match.canMergeSafely)
			mergeTooltip =
				"Merge is disabled. A snapshot of the previously imported version was not found.";

		this.createButtonRow(main, [
			{
				text: "Merge",
				icon: "git-merge",
				cta: !isMergeDisabled, // This is the primary action
				disabled: isMergeDisabled,
				tooltip: mergeTooltip,
				onClick: () => this.handleChoice("merge"),
			},
			{
				text: "Replace",
				icon: "replace-all",
				warning: true,
				tooltip: "Overwrites the existing note. Any local edits will be lost.",
				onClick: () => this.handleChoice("replace"),
			},
			{
				text: "Keep Both",
				icon: "copy",
				tooltip: "Creates a new, separate note for the incoming highlights.",
				onClick: () => this.handleChoice("keep-both"),
			},
			{
				text: "Skip",
				icon: "x",
				cta: isMergeDisabled,
				tooltip: "Skips importing this book for now.",
				onClick: () => this.handleChoice("skip"),
			},
		]);

		const shortcuts = main.createDiv("duplicate-shortcuts");
		shortcuts.appendText("Shortcuts: ");
		shortcuts.createEl("kbd", { text: "Enter" });
		shortcuts.appendText(` to ${isMergeDisabled ? "Skip" : "Merge"}, `);
		shortcuts.createEl("kbd", { text: "Esc" });
		shortcuts.appendText(" to Skip");
	}

	private handleChoice(choice: DuplicateChoice) {
		this.choice = choice;
		// The toggle's onChange has already updated this.session.applyToAll
		if (this.session.applyToAll) {
			this.session.choice = choice;
		}
		this.resolveAndClose({
			choice: this.choice,
			applyToAll: this.session.applyToAll,
		});
	}

	protected registerShortcuts(): void {
		super.registerShortcuts(); // Handles Enter and Escape
		this.registerShortcut(["Mod"], "m", () => this.handleChoice("merge"));
		this.registerShortcut(["Mod"], "r", () => this.handleChoice("replace"));
		this.registerShortcut(["Mod"], "k", () => this.handleChoice("keep-both"));
		this.registerShortcut(["Mod"], "s", () => this.handleChoice("skip"));
	}

	protected getFocusElement(): HTMLElement | null {
		// Resiliently find the primary action button to focus.
		return this.contentEl.querySelector<HTMLElement>(".cta:not([disabled])");
	}

	private getMatchTypeLabel(): string {
		return {
			exact: "Exact Match",
			updated: "Updated Content",
			divergent: "Content Differs",
		}[this.match.matchType];
	}
}
