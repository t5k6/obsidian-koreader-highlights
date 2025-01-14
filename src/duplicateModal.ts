import { type App, ButtonComponent, Modal, Setting } from "obsidian";
import type { DuplicateMatch } from "./duplicateHandler";
import type { DuplicateChoice, IDuplicateHandlingModal } from "./types";

export class DuplicateHandlingModal extends Modal
    implements IDuplicateHandlingModal {
    private choice: DuplicateChoice = "skip";
    private applyToAll = false;
    private resolvePromise:
        | ((value: { choice: DuplicateChoice; applyToAll: boolean }) => void)
        | null = null;

    constructor(
        app: App,
        private match: DuplicateMatch,
        private message: string,
        private title = "Duplicate Highlights Found",
    ) {
        super(app);
    }

    async openAndGetChoice(): Promise<
        { choice: DuplicateChoice; applyToAll: boolean }
    > {
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl } = this;

        contentEl.createEl("h2", { text: this.title });
        contentEl.createEl("p", { text: this.message });

        // Statistics
        const statsDiv = contentEl.createDiv({ cls: "duplicate-stats" });
        if (this.match.matchType !== "exact") {
            statsDiv.createEl("p", {
                text: `New highlights: ${this.match.newHighlights}`,
                cls: "stat-item",
            });
            statsDiv.createEl("p", {
                text: `Modified highlights: ${this.match.modifiedHighlights}`,
                cls: "stat-item",
            });
        }

        new Setting(contentEl)
            .setName("Existing file")
            .setDesc(this.match.file.path)
            .setClass("duplicate-file-path");

        new Setting(contentEl)
            .setName("Apply to all remaining items")
            .addToggle((toggle) => {
                toggle.setValue(this.applyToAll).onChange((value) => {
                    this.applyToAll = value;
                });
            });

        this.createOptionButtons(contentEl);

        contentEl.addEventListener("keydown", this.handleKeydown.bind(this));
    }

    private createOptionButtons(contentEl: HTMLElement) {
        const buttonContainer = contentEl.createDiv({
            cls: "duplicate-buttons",
        });

        const replaceButton = new ButtonComponent(buttonContainer)
            .setButtonText("Replace")
            .onClick(() => this.handleChoice("replace"));
        if (this.match.matchType === "exact") {
            replaceButton.setClass("mod-warning");
        }

        const mergeButton = new ButtonComponent(buttonContainer)
            .setButtonText("Merge")
            .onClick(() => this.handleChoice("merge"));
        if (this.match.matchType === "exact") {
            mergeButton.setDisabled(true);
            mergeButton.setTooltip("No new content to merge");
            buttonContainer.createEl("span", {
                text: "ℹ️",
                cls: "merge-info-icon",
            })
                .setAttribute("title", "No new content to merge");
        }

        new ButtonComponent(buttonContainer)
            .setButtonText("Keep Both")
            .onClick(() => this.handleChoice("keep-both"));

        new ButtonComponent(buttonContainer)
            .setButtonText("Skip")
            .setCta()
            .onClick(() => this.handleChoice("skip"));
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
        contentEl.removeEventListener("keydown", this.handleKeydown.bind(this));
        if (this.resolvePromise) {
            this.resolvePromise({ choice: "skip", applyToAll: false });
            this.resolvePromise = null;
        }
    }
}
