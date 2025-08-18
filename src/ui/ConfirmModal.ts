import type { App } from "obsidian";
import { BaseModal } from "./BaseModal";

export class ConfirmModal extends BaseModal<boolean> {
	constructor(
		app: App,
		titleText: string,
		private bodyText: string,
	) {
		super(app, {
			title: titleText,
			className: "confirm-modal",
			enableEscape: true,
			enableEnter: true,
			focusOnOpen: true,
		});
	}

	protected renderContent(contentEl: HTMLElement): void {
		contentEl.createEl("p", { text: this.bodyText });
		this.createButtonRow(contentEl, [
			{
				text: "Proceed",
				warning: true,
				onClick: () => this.resolveAndClose(true),
			},
			{ text: "Cancel", onClick: () => this.cancel() },
		]);
	}

	protected handleEnter(): void {
		this.resolveAndClose(true);
	}
}
