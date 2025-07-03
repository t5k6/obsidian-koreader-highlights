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
	private boundKeydownHandler: (event: KeyboardEvent) => void; // Add bound handler reference

	constructor(
		app: App,
		private match: DuplicateMatch,
		private message: string,
		private title = "Duplicate Highlights Found",
	) {
		super(app);
		this.boundKeydownHandler = this.handleKeydown.bind(this); // Bind once in constructor
	}

	async openAndGetChoice(): Promise<{
		choice: DuplicateChoice | null;
		applyToAll: boolean;
	}> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.setAttribute("role", "dialog"); 
		contentEl.setAttribute("aria-labelledby", "modal-title");

		// Add main container with max width
		const container = contentEl.createDiv({
			cls: "duplicate-modal-container",
			attr: { "aria-modal": "true" },
		});

		// Header section
		const headerEl = container.createDiv({ cls: "duplicate-modal-header" });
		headerEl.createEl("h2", {
			text: this.title,
			attr: { id: "modal-title" }, 
		});

		// Add match type badge
		const badgeEl = headerEl.createEl("span", {
			cls: `duplicate-badge duplicate-badge-${this.match.matchType}`,
			text: this.getMatchTypeLabel(),
		});

		// Message and file path
		const messageEl = container.createDiv({ cls: "duplicate-message" });
		messageEl.createEl("p", { text: this.message });

		const filePathEl = messageEl.createDiv({ cls: "duplicate-file-path" });
		setIcon(filePathEl.createSpan(), "file-text");
		filePathEl.createSpan({ text: this.match.file.path });

		// Statistics section
		if (this.match.matchType !== "exact") {
			const statsEl = container.createDiv({ cls: "duplicate-stats" });

			const createStatItem = (icon: string, label: string, value: number) => {
				const statItem = statsEl.createDiv({ cls: "stat-item" });
				setIcon(statItem.createSpan({ cls: "stat-icon" }), icon);
				statItem.createSpan({ text: label });
				statItem.createSpan({
					cls: "stat-value",
					text: value.toString(),
				});
			};

			createStatItem(
				"plus-circle",
				"New highlights:",
				this.match.newHighlights,
			);
			createStatItem(
				"edit",
				"Modified highlights:",
				this.match.modifiedHighlights,
			);
		}

		// Apply to all setting
		const settingsEl = container.createDiv({ cls: "duplicate-settings" });
		new Setting(settingsEl)
			.setName("Apply to all remaining items")
			.setDesc("Use the same action for all subsequent duplicates")
			.addToggle((toggle) => {
				toggle.setValue(this.applyToAll).onChange((value) => {
					this.applyToAll = value;
				});
			});

		// Action buttons
		this.createActionButtons(container);

		// Keyboard shortcuts help
		const shortcutsEl = container.createDiv({ cls: "duplicate-shortcuts" });
		shortcutsEl.createEl("span", { text: "Shortcuts: " });
		shortcutsEl.createEl("kbd", { text: "Enter" });
		shortcutsEl.createSpan({ text: " to Replace, " });
		shortcutsEl.createEl("kbd", { text: "Esc" });
		shortcutsEl.createSpan({ text: " to Skip" });

		contentEl.addEventListener("keydown", this.boundKeydownHandler); // Use stored reference

		container.focus();
	}

	private getMatchTypeLabel(): string {
		const labels = {
			exact: "Exact Match",
			updated: "Updated Content",
			divergent: "Content Differs",
		};
		return labels[this.match.matchType];
	}

	private createActionButtons(container: HTMLElement) {
		const buttonContainer = container.createDiv({
			cls: "duplicate-buttons",
		});

		const createButton = (
			text: string,
			choice: DuplicateChoice,
			icon: string,
			options: {
				warning?: boolean;
				disabled?: boolean;
				tooltip?: string;
				primary?: boolean;
			} = {},
		) => {
			const buttonEl = buttonContainer.createDiv({
				cls: "button-container",
			});
			const button = new ButtonComponent(buttonEl)
				.setButtonText(text)
				.onClick(() => this.handleChoice(choice));

			const iconSpan = button.buttonEl.createSpan({ cls: "button-icon" });
			setIcon(iconSpan, icon);
			iconSpan.style.marginLeft = "4px";

			if (options.warning) button.setClass("mod-warning");
			if (options.disabled) {
				button.setDisabled(true);
				if (options.tooltip) button.setTooltip(options.tooltip);
			}
			if (options.primary) button.setCta();
		};

		createButton("Replace ", "replace", "replace-all", {
			warning: this.match.matchType === "exact",
			tooltip:
				"Replace the existing file with the new one. This will overwrite all existing content in the file.",
		});

		createButton("Merge ", "merge", "git-merge", {
			disabled: this.match.matchType === "exact",
			tooltip:
				this.match.matchType === "exact"
					? "No new content to merge"
					: "Merge new highlights with existing content while preserving existing notes",
		});

		createButton("Keep Both ", "keep-both", "copy", {
			tooltip:
				"Create a new file for the imported highlights and retain the original. Useful when you want to keep both versions.",
		});

		createButton("Skip ", "skip", "x", {
			primary: true,
			tooltip: "Skip importing this file and leave the existing one unchanged",
		});
	}

	private handleChoice(choice: DuplicateChoice) {
		this.choice = choice;
		this.closeModal();
	}

	private closeModal() {
		if (this.resolvePromise) {
			this.resolvePromise({
				choice: this.choice,
				applyToAll: this.applyToAll,
			});
			this.resolvePromise = null;
		}
		this.close();
	}

	private handleKeydown(event: KeyboardEvent) {
		if (event.key === "Escape") {
			this.handleChoice("skip");
		} else if (event.key === "Enter") {
			this.handleChoice("replace");
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.removeEventListener("keydown", this.boundKeydownHandler); // Remove using same reference
		if (this.resolvePromise) {
			this.resolvePromise({ choice: "skip", applyToAll: false });
			this.resolvePromise = null;
		}
	}
}
