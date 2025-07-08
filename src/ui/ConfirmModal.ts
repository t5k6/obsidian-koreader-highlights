import { type App, ButtonComponent, Modal } from "obsidian";

export class ConfirmModal extends Modal {
	private confirmed = false;
	private resolvePromise!: (value: boolean) => void;

	constructor(
		app: App,
		private titleText: string,
		private bodyText: string,
	) {
		super(app);
	}

	async openAndConfirm(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen() {
		this.titleEl.setText(this.titleText);
		this.contentEl.createEl("p", { text: this.bodyText });

		const buttonContainer = this.contentEl.createDiv({
			cls: "modal-button-container",
		});

		new ButtonComponent(buttonContainer)
			.setButtonText("Proceed")
			.setWarning()
			.onClick(() => {
				this.confirmed = true;
				this.close();
			});

		new ButtonComponent(buttonContainer).setButtonText("Cancel").onClick(() => {
			this.confirmed = false;
			this.close();
		});
	}

	onClose() {
		this.resolvePromise(this.confirmed);
	}
}
