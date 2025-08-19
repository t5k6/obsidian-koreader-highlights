import { type App, Notice } from "obsidian";
import { toFileSafe } from "src/lib/pathing";

export type RenameResult = { stem: string } | { cancelled: true };
export type ConfirmationDecision = "confirm" | "cancel";

export class PromptService {
	constructor(private app: App) {}

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

			const rawValue = (await prompt.openAndAwaitResult())?.trim() ?? null;

			if (!rawValue) {
				return { cancelled: true };
			}

			const sanitized = toFileSafe(rawValue, { fallback: "" });
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
	}): Promise<ConfirmationDecision> {
		// Reuse ConfirmModal (labels are fixed in current implementation)
		const { ConfirmModal } = await import("src/ui/ConfirmModal");
		const modal = new ConfirmModal(this.app, params.title, params.message);
		const ok = (await modal.openAndAwaitResult()) ?? false;
		return ok ? "confirm" : "cancel";
	}
}
