import { type App, Notice } from "obsidian";
import { Pathing } from "src/lib/pathing";
import type { StaleLocationChoice, StaleLocationSession } from "src/types";
import { InteractionModal } from "src/ui/InteractionModal";

export type RenameResult = { stem: string } | { cancelled: true };
export type StaleLocationDecision = "merge-stale" | "create-new" | "skip-stale";

/**
 * Requests a new file name from the user, with optional validation.
 * Loops until valid or cancelled.
 */
export async function requestNewFileName(
	app: App,
	params: {
		defaultStem: string;
		folder: string;
		validate?: (stem: string) => string | null;
	},
	signal?: AbortSignal,
): Promise<RenameResult> {
	let currentStem = params.defaultStem;

	while (true) {
		// Pass signal to modal if it supports it (future-proof)
		const rawValue = await InteractionModal.prompt(app, {
			title: "Choose a new filename",
			placeholder: "New filename (without extension)",
			defaultValue: currentStem,
		});
		if (signal?.aborted) {
			return { cancelled: true };
		}

		if (rawValue === null) {
			// User cancelled
			return { cancelled: true };
		}

		const sanitized = Pathing.toFileSafe(rawValue, { fallback: "" });
		const error = params.validate ? params.validate(sanitized) : null;

		if (error) {
			new Notice(error, 4000);
			currentStem = sanitized; // Re-prompt with the invalid input for easy editing
			continue;
		}

		return { stem: sanitized };
	}
}

/**
 * Shows a choice modal for stale location decisions.
 * Supports apply-to-all session.
 */
export async function confirmStaleLocation(
	app: App,
	params: {
		title: string;
		message: string;
		session: StaleLocationSession;
	},
	signal?: AbortSignal,
): Promise<StaleLocationDecision> {
	if (params.session.applyToAll && params.session.choice) {
		return params.session.choice;
	}

	const result = await InteractionModal.choice<StaleLocationChoice>(app, {
		title: params.title,
		message: params.message,
		choices: [
			{
				value: "merge-stale",
				label: "Merge into existing note",
				cta: true,
			},
			{ value: "create-new", label: "Create new note" },
		],
		session: params.session,
	});
	if (signal?.aborted) {
		return "skip-stale"; // Map abort to skip for consistency
	}

	// If the user pressed Escape, result.choice will be null. We map this to 'skip-stale'.
	const finalChoice = result.choice ?? "skip-stale";

	// If the user enabled "Apply to all", update the session for subsequent calls.
	if (result.applyToAll) {
		params.session.applyToAll = true;
		params.session.choice = finalChoice;
	}

	return finalChoice;
}
