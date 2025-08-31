import path from "node:path";
import type { App } from "obsidian";
import { BaseModal } from "./BaseModal";

export class ProgressModal extends BaseModal<void> {
	public statusEl!: HTMLElement;
	private progressEl: HTMLProgressElement | null = null;
	private spinnerEl: HTMLElement | null = null;
	private total: number | null = null;
	private controller: AbortController;
	private baseTitle: string;

	constructor(app: App, title?: string) {
		super(app, { title: title ?? "Importing Highlights and Notes" });
		this.controller = new AbortController();
		this.baseTitle = this.config.title;
	}

	private ensureStatusEl(): void {
		if (!this.statusEl) {
			const ce: any = (this as any).contentEl;
			if (ce && typeof ce.createEl === "function") {
				this.statusEl = ce.createEl("p", { text: "" });
			} else {
				this.statusEl = document?.createElement?.("p") ?? ({} as any);
			}
		}
	}

	private setStatus(text: string): void {
		this.ensureStatusEl();
		const el: any = this.statusEl as any;
		if (el && typeof el.setText === "function") el.setText(text);
		else if (el) el.textContent = text;
	}

	public get abortSignal(): AbortSignal {
		return this.controller.signal;
	}

	protected renderContent(contentEl: HTMLElement): void {
		if (this.titleEl && (this.titleEl as any).setText) {
			(this.titleEl as any).setText(this.baseTitle);
		}
		// Prefer Obsidian helper; fallback for test envs missing it
		if ((contentEl as any).createEl) {
			this.statusEl = (contentEl as any).createEl("p", {
				text: "Collecting files...",
			});
		} else {
			this.statusEl = document?.createElement?.("p") ?? ({} as any);
			if ("textContent" in (this.statusEl as any)) {
				(this.statusEl as any).textContent = "Collecting files...";
			}
		}

		this.createButtonRow(contentEl, [
			{ text: "Cancel", warning: true, onClick: () => this.cancelAndAbort() },
		]);
	}

	protected onCleanup(): void {
		if (!this.controller.signal.aborted) {
			this.controller.abort();
		}
	}

	private cancelAndAbort(): void {
		if (!this.controller.signal.aborted) {
			this.controller.abort();
		}
		this.cancel();
	}

	/**
	 * Toggles the indeterminate (spinner) state.
	 * In this state, the progress bar is hidden, and an animated spinner is shown.
	 */
	public setIndeterminate(on: boolean): void {
		if (on) {
			// If the spinner doesn't exist, create it.
			if (!this.spinnerEl) {
				this.spinnerEl = this.contentEl.createDiv({ cls: "koreader-spinner" });
			}
			this.spinnerEl.style.display = "";

			// Hide the progress bar if it exists.
			if (this.progressEl) {
				this.progressEl.style.display = "none";
			}

			// Reset title to base, as percentage is meaningless here.
			if (this.titleEl && (this.titleEl as any).setText) {
				(this.titleEl as any).setText(this.baseTitle);
			}
		} else {
			// Hide the spinner if it exists.
			if (this.spinnerEl) {
				this.spinnerEl.style.display = "none";
			}
			// Show the progress bar if it exists.
			if (this.progressEl) {
				this.progressEl.style.display = "";
			}
		}
	}

	public setTotal(total: number) {
		// Setting a total always implies the state is now determinate.
		this.setIndeterminate(false);

		this.total = total;
		this.setStatus("Processing files...");

		// Create progress element if it doesn't exist yet.
		if (!this.progressEl) {
			const el = document.createElement("progress");
			this.progressEl = el;
			const buttonContainer = this.contentEl.querySelector(
				".modal-button-container",
			);
			if (buttonContainer && buttonContainer.parentElement) {
				buttonContainer.parentElement.insertBefore(el, buttonContainer);
			} else {
				this.contentEl.appendChild(el);
			}
		}
		this.progressEl.max = total;
		this.progressEl.value = 0;
	}

	updateProgress(completed: number, currentFileOrMessage?: string) {
		if (this.progressEl && this.total !== null) {
			this.progressEl.value = completed;
			const percentage = Math.round((completed / this.total) * 100);
			if (this.titleEl && (this.titleEl as any).setText) {
				(this.titleEl as any).setText(`${this.baseTitle} (${percentage}%)`);
			}
		}
		if (currentFileOrMessage) {
			// If it's a path, show basename; otherwise show the message as-is
			const maybeBasename = /[\\/]/.test(currentFileOrMessage)
				? path.basename(currentFileOrMessage)
				: currentFileOrMessage;
			this.setStatus(`Processing: ${maybeBasename}`);
		}
	}
}
