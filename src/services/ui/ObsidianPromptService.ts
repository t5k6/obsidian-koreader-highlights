import { type App, Notice } from "obsidian";
import { normalizeFileNamePiece } from "src/lib/pathing/fileNaming";
import type {
	ConfirmationDecision,
	IncompleteScanDecision,
	PromptService,
	RenameResult,
} from "./PromptService";

export class ObsidianPromptService implements PromptService {
	constructor(private app: App) {}

	async onIncompleteScan(params: {
		title: string;
		existingPath: string | null;
	}): Promise<IncompleteScanDecision> {
		const { PromptModal } = await import("src/ui/PromptModal");
		return await new Promise<IncompleteScanDecision>((resolve) => {
			const ModalCtor = PromptModal as unknown as {
				new (
					app: import("obsidian").App,
					title: string,
					options: { label: string; isCta?: boolean; callback: () => void }[],
					message: string,
				): { open: () => void };
			};
			const modalMessage =
				`The duplicate scan for “${params.title}” did not complete. A safe merge cannot be guaranteed.\n\n` +
				(params.existingPath
					? `A potential match was found at: ${params.existingPath}\n`
					: "") +
				`You can create a new file (with a warning) or skip importing this book for now.`;
			const modal = new ModalCtor(
				this.app,
				"Duplicate Scan Incomplete",
				[
					{ label: "Skip this book", callback: () => resolve("skip") },
					{
						label: "Create New File (Warn)",
						isCta: true,
						callback: () => resolve("create-new"),
					},
				],
				modalMessage,
			);
			modal.open();
		});
	}

	async requestNewFileName(params: {
		defaultStem: string;
		folder: string;
		validate?: (stem: string) => string | null;
	}): Promise<RenameResult> {
		const { PromptModal } = await import("src/ui/PromptModal");

		while (true) {
			const prompt = new (PromptModal as any)(
				this.app,
				"Choose a new filename",
				"New filename (without extension)",
				params.defaultStem,
			);

			const rawValue = (await prompt.openAndGetValue())?.trim();

			if (!rawValue) {
				return { cancelled: true };
			}

			const sanitized = normalizeFileNamePiece(rawValue);
			const error = params.validate ? params.validate(sanitized) : null;

			if (error) {
				new Notice(error, 4000);
				params.defaultStem = sanitized; // re-prompt with user input for editing
				continue;
			}

			return { stem: sanitized };
		}
	}

	async confirm(params: {
		title: string;
		message: string;
		ctaLabel?: string;
		cancelLabel?: string;
	}): Promise<ConfirmationDecision> {
		// Reuse ConfirmModal (labels are fixed in current implementation)
		const { ConfirmModal } = await import("src/ui/ConfirmModal");
		const modal = new ConfirmModal(this.app, params.title, params.message);
		const ok = await modal.openAndConfirm();
		return ok ? "confirm" : "cancel";
	}
}
