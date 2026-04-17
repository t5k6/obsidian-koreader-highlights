import { type App, Notice, type TFile } from "obsidian";
import { isErr } from "src/lib/core/result";
import type { BackupInfo, NotePersistenceService } from "src/services/vault/NotePersistenceService";
import { BaseModal } from "./BaseModal";
import { SuggestionList } from "./SuggestionList";

export interface RestoreBackupModalResult {
  backupPath: string;
}

export class RestoreBackupModal extends BaseModal<RestoreBackupModalResult> {
  private suggestionList: SuggestionList<BackupInfo> | null = null;
  private previewEl: HTMLElement | null = null;
  private selectedBackup: BackupInfo | null = null;

  constructor(
    app: App,
    private persistenceService: NotePersistenceService,
    private targetFile: TFile,
  ) {
    super(app, {
      title: "Restore Note from Backup",
      className: "restore-backup-modal",
      ariaLabel: "Restore note from backup dialog",
      enableEscape: true,
      enableEnter: true,
      focusOnOpen: true,
      preventMultipleResolve: true,
    });
  }

  protected renderContent(contentEl: HTMLElement): void {
    // Create header
    const headerEl = contentEl.createDiv({ cls: "modal-header" });
    headerEl.createEl("h3", { text: "Select a backup to restore" });
    headerEl.createEl("p", {
      text: `Restoring from backup will overwrite the current content of "${this.targetFile.basename}".`,
      cls: "modal-description",
    });

    // Create main content area
    const mainEl = contentEl.createDiv({ cls: "modal-main" });

    // Create suggestion list container
    const listContainer = mainEl.createDiv({ cls: "backup-list-container" });
    listContainer.createEl("h4", {
      text: "Available Backups",
      cls: "list-title",
    });

    // Create suggestion list
    this.suggestionList = new SuggestionList<BackupInfo>(this.app, {
      containerEl: listContainer,
      containerClass: "backup-suggestion-list",
      maxVisibleItems: 8,
      renderItem: (item: BackupInfo, el: HTMLElement) => {
        const itemContent = el.createDiv({ cls: "backup-item-content" });

        const titleRow = itemContent.createDiv({ cls: "backup-title-row" });
        titleRow.createEl("span", {
          text: item.formattedTime,
          cls: "backup-timestamp",
        });
        titleRow.createEl("span", {
          text: `${item.size} bytes`,
          cls: "backup-size",
        });

        const previewRow = itemContent.createDiv({ cls: "backup-preview-row" });
        previewRow.createEl("span", {
          text: `Backup file: ${item.basename}`,
          cls: "backup-filename",
        });
      },
      onSelect: (item: BackupInfo) => {
        this.handleBackupSelect(item);
      },
    });

    // Create preview area
    const previewContainer = mainEl.createDiv({
      cls: "backup-preview-container",
    });
    previewContainer.createEl("h4", {
      text: "Backup Preview",
      cls: "preview-title",
    });

    this.previewEl = previewContainer.createDiv({
      cls: "backup-preview-content",
    });
    this.previewEl.createEl("p", {
      text: "Select a backup from the list to preview its content.",
      cls: "preview-placeholder",
    });

    // Create footer with buttons
    const footerEl = contentEl.createDiv({ cls: "modal-footer" });

    this.createButtonRow(footerEl, [
      {
        text: "Cancel",
        onClick: () => this.cancel(),
        icon: "x",
        cta: false,
        warning: false,
      },
      {
        text: "Restore Selected",
        onClick: () => this.handleRestore(),
        icon: "history",
        cta: true,
        warning: true,
        disabled: true,
        tooltip: "Select a backup to enable restore",
      },
    ]);

    // Load backups
    this.loadBackups();
  }

  private async loadBackups(): Promise<void> {
    this.suggestionList?.showEmpty("Loading backups…");

    try {
      const backups = await this.persistenceService.getBackupsForFile(this.targetFile);

      if (backups.length === 0) {
        this.suggestionList?.showEmpty("No backups found for this file.");
        this.updateRestoreButton(false);
        return;
      }

      this.suggestionList?.setItems(backups);
    } catch (error) {
      console.error("Failed to load backups:", error);
      this.suggestionList?.showEmpty("Failed to load backups. Please try again.");
      new Notice("Failed to load backups. Check console for details.", 5000);
    }
  }

  private handleBackupSelect(backup: BackupInfo): void {
    this.selectedBackup = backup;
    this.loadPreview(backup);
    this.updateRestoreButton(true);
  }

  private async loadPreview(backup: BackupInfo): Promise<void> {
    if (!this.previewEl) return;

    try {
      // Read backup content via adapter (files in .obsidian aren't accessible via vault.read)
      const content = await this.app.vault.adapter.read(backup.path);

      // Clear preview
      this.previewEl.empty();

      // Create preview content
      const previewContent = this.previewEl.createDiv({
        cls: "backup-preview-text",
      });

      // Show first few lines as preview
      const lines = content.split("\n");
      const previewLines = lines.slice(0, 10); // Show first 10 lines
      const previewText = previewLines.join("\n");

      // Create a code block for better formatting
      const codeBlock = previewContent.createEl("pre", {
        cls: "backup-preview-code",
      });
      codeBlock.createEl("code", { text: previewText });

      // Add preview info
      const infoEl = this.previewEl.createDiv({ cls: "preview-info" });
      infoEl.createEl("span", {
        text: `Showing first ${previewLines.length} lines of ${lines.length} total lines`,
        cls: "preview-line-count",
      });
    } catch (error) {
      console.error("Failed to load backup preview:", error);
      this.previewEl.empty();
      this.previewEl.createEl("p", {
        text: "Failed to load preview. The backup file may be corrupted.",
        cls: "preview-error",
      });
    }
  }

  private updateRestoreButton(enabled: boolean): void {
    const restoreButton = this.contentEl.querySelector<HTMLButtonElement>(".modal-footer .cta");
    if (restoreButton) {
      restoreButton.disabled = !enabled;
      restoreButton.title = enabled
        ? "Restore from selected backup"
        : "Select a backup to enable restore";
    }
  }

  private async handleRestore(): Promise<void> {
    if (!this.selectedBackup) {
      new Notice("Please select a backup to restore.", 4000);
      return;
    }

    try {
      // Show confirmation dialog
      const confirmed = await this.showConfirmationDialog();
      if (!confirmed) {
        return;
      }

      // Perform restore
      const restoreResult = await this.persistenceService.restoreBackup(
        this.targetFile,
        this.selectedBackup.path,
      );

      if (isErr(restoreResult)) {
        throw restoreResult.error;
      }

      // Success
      new Notice(`Successfully restored ${this.targetFile.basename} from backup.`, 5000);
      this.resolveAndClose({
        backupPath: this.selectedBackup.path,
      });
    } catch (error) {
      console.error("Restore failed:", error);
      new Notice("Restore failed. Check console for details.", 5000);
    }
  }

  private async showConfirmationDialog(): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new BaseModal(this.app, {
        title: "Confirm Restore",
        className: "restore-confirmation-modal",
        ariaLabel: "Confirm restore dialog",
        enableEscape: true,
        enableEnter: true,
        focusOnOpen: true,
        preventMultipleResolve: true,
        render: (contentEl) => {
          const header = contentEl.createDiv({ cls: "confirmation-header" });
          header.createEl("h3", { text: "Restore from Backup" });
          header.createEl("p", {
            text: "This will overwrite the current content of the note with the selected backup.",
            cls: "confirmation-warning",
          });

          const details = contentEl.createDiv({ cls: "confirmation-details" });
          details.createEl("p", {
            text: `Backup: ${this.selectedBackup?.formattedTime}`,
            cls: "confirmation-detail",
          });
          details.createEl("p", {
            text: `File: ${this.targetFile.basename}`,
            cls: "confirmation-detail",
          });

          const footer = contentEl.createDiv({ cls: "confirmation-footer" });
          this.createButtonRow(footer, [
            {
              text: "Cancel",
              onClick: () => {
                modal.close();
                resolve(false);
              },
              icon: "x",
              cta: false,
              warning: false,
            },
            {
              text: "Restore",
              onClick: () => {
                modal.close();
                resolve(true);
              },
              icon: "history",
              cta: true,
              warning: true,
            },
          ]);
        },
      });

      modal.openAndAwaitResult().then((result) => {
        resolve(result != null);
      });
    });
  }

  protected onCleanup(): void {
    if (this.suggestionList) {
      this.suggestionList.unload();
      this.suggestionList = null;
    }
    this.previewEl = null;
    this.selectedBackup = null;
  }
}
