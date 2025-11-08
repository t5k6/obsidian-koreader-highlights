import { Notice } from "obsidian";
import type { LoggingService } from "src/services/LoggingService";
import type {
	IndexDatabase,
	RebuildStatus,
} from "src/services/vault/index/IndexDatabase";

export class IndexRebuildStatusService {
	private readonly log;
	private unsubscribe?: () => void;

	constructor(
		private readonly indexDb: IndexDatabase,
		logging: LoggingService,
	) {
		this.log = logging.scoped("IndexRebuildStatusService");
	}

	public initialize(): void {
		this.unsubscribe = this.indexDb.onRebuildStatus((status) => {
			this.handleRebuildStatus(status);
		});
	}

	private handleRebuildStatus(status: RebuildStatus): void {
		switch (status.phase) {
			case "rebuilding":
				// Could update status bar or show progress notice
				if (status.progress) {
					this.log.info(
						`Index rebuild progress: ${status.progress.current}/${status.progress.total}`,
					);
				} else {
					this.log.info("Index rebuild started");
				}
				break;
			case "complete":
				new Notice("Index rebuild completed successfully", 3000);
				this.log.info("Index rebuild completed");
				break;
			case "failed":
				new Notice(
					`Index rebuild failed: ${status.error instanceof Error ? status.error.message : status.error}`,
					8000,
				);
				this.log.error("Index rebuild failed", status.error);
				break;
			case "cancelled":
				new Notice("Index rebuild was cancelled", 3000);
				this.log.info("Index rebuild cancelled");
				break;
			case "idle":
				// No action needed
				break;
		}
	}

	public dispose(): void {
		this.unsubscribe?.();
	}
}
