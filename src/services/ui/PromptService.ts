export type IncompleteScanDecision = "skip" | "create-new";
export type RenameResult = { stem: string } | { cancelled: true };
export type ConfirmationDecision = "confirm" | "cancel";

export interface PromptService {
	/**
	 * Handles the case where a duplicate scan is incomplete.
	 * A merge is not offered as it cannot be guaranteed to be safe.
	 */
	onIncompleteScan(params: {
		title: string;
		existingPath: string | null;
	}): Promise<IncompleteScanDecision>;

	/**
	 * Prompts the user for a new filename stem, handling validation and cancellation.
	 */
	requestNewFileName(params: {
		defaultStem: string;
		folder: string;
		validate?: (stem: string) => string | null; // Returns error message or null
	}): Promise<RenameResult>;

	/**
	 * Displays a generic confirmation modal to the user.
	 * @returns A promise resolving to "confirm" or "cancel".
	 */
	confirm(params: {
		title: string;
		message: string;
		ctaLabel?: string; // e.g., "Yes, Proceed"
		cancelLabel?: string; // e.g., "Cancel"
	}): Promise<ConfirmationDecision>;
}
