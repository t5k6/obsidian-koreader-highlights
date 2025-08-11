import { type App, ButtonComponent } from "obsidian";
import { BaseModal } from "./BaseModal";

export class ConfirmModal extends BaseModal<boolean> {
	private confirmBtn: ButtonComponent | null = null;

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

	async openAndConfirm(): Promise<boolean> {
		const res = await this.openAndAwaitResult();
		return res ?? false;
	}

	protected renderContent(contentEl: HTMLElement): void {
		contentEl.createEl("p", { text: this.bodyText });

		const buttonContainer = contentEl.createDiv({
			cls: "modal-button-container",
		});

		this.confirmBtn = new ButtonComponent(buttonContainer)
			.setButtonText("Proceed")
			.setWarning()
			.onClick(() => this.resolveAndClose(true));

		new ButtonComponent(buttonContainer)
			.setButtonText("Cancel")
			.onClick(() => this.cancel());
	}

	protected handleEnter(): void {
		this.resolveAndClose(true);
	}

	protected getFocusElement(): HTMLElement | null {
		return this.confirmBtn?.buttonEl ?? null;
	}
}
