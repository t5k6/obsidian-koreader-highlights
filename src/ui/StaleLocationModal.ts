import { type App, Setting } from "obsidian";
import type { StaleLocationChoice, StaleLocationSession } from "src/types";
import { BaseModal } from "./BaseModal";

export class StaleLocationModal extends BaseModal<{
	choice: StaleLocationChoice | null;
	applyToAll: boolean;
}> {
	private choice: StaleLocationChoice = "skip-stale";
	private applyToAll = false;

	constructor(
		app: App,
		private titleText: string,
		private messageText: string,
		private session: StaleLocationSession,
	) {
		super(app, {
			title: titleText,
			className: "koreader-stale-location-modal",
			enableEscape: true,
			enableEnter: true,
			focusOnOpen: true,
		});
		this.applyToAll = this.session?.applyToAll ?? false;
	}

	protected renderContent(contentEl: HTMLElement): void {
		contentEl.createEl("p", { text: this.messageText });

		new Setting(contentEl)
			.setName("Apply to all remaining files in this import")
			.setDesc(
				"Use the same action for all subsequent notes found outside the highlights folder during this run.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.applyToAll).onChange((v) => {
					this.applyToAll = v;
				}),
			);

		this.createButtonRow(contentEl, [
			{
				text: "Merge into Existing",
				cta: true,
				onClick: () => this.handleChoice("merge-stale"),
			},
			{
				text: "Skip This Book",
				onClick: () => this.handleChoice("skip-stale"),
			},
		]);
	}

	private handleChoice(choice: StaleLocationChoice): void {
		this.choice = choice;
		if (this.applyToAll) {
			this.session.applyToAll = true;
			this.session.choice = choice;
		}
		this.resolveAndClose({ choice: this.choice, applyToAll: this.applyToAll });
	}

	protected handleEnter(): void {
		this.handleChoice("merge-stale");
	}

	protected registerShortcuts(): void {
		super.registerShortcuts();
		// Escape should act as "skip"
		this.registerShortcut([], "Escape", () => this.handleChoice("skip-stale"));
	}
}
