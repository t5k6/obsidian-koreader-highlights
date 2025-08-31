import { err, ok, type Result } from "src/lib/core/result";
import type {
	DuplicateMatch,
	KoreaderHighlightImporterSettings,
} from "src/types";

export type MergeStrategy =
	| "auto-merge"
	| "prompt-user"
	| "direct-replace"
	| "direct-merge";

export interface MergeContext {
	analysis: DuplicateMatch;
	settings: Pick<KoreaderHighlightImporterSettings, "autoMergeOnAddition">;
	isUpdateOnly: boolean;
	canMergeSafely: boolean;
}

export function determineMergeStrategy(ctx: MergeContext): MergeStrategy {
	const { settings, isUpdateOnly, canMergeSafely } = ctx;

	if (settings.autoMergeOnAddition && isUpdateOnly && canMergeSafely) {
		return "auto-merge";
	}

	// Add other pure decision logic here
	return "prompt-user";
}

export function createMergeContext(
	analysis: DuplicateMatch,
	settings: Pick<KoreaderHighlightImporterSettings, "autoMergeOnAddition">,
): MergeContext {
	return {
		analysis,
		settings,
		isUpdateOnly:
			analysis.matchType === "updated" && analysis.modifiedHighlights === 0,
		canMergeSafely: analysis.canMergeSafely,
	};
}

export function buildPromptMessage(
	analysis: DuplicateMatch,
	highlightsFolder?: string,
): Result<string, Error> {
	try {
		let promptMessage = "Duplicate detected – choose an action";

		if (analysis.matchType === "exact") {
			const folderPrefix =
				highlightsFolder && highlightsFolder.endsWith("/")
					? highlightsFolder
					: `${highlightsFolder || ""}/`;
			const inHighlights = analysis.file.path.startsWith(folderPrefix);
			if (!inHighlights && highlightsFolder) {
				promptMessage =
					`An existing note for this book already exists at "${analysis.file.path}", which is outside your current Highlights folder ("${highlightsFolder}").\n\n` +
					"Choose how to proceed:\n" +
					"• Keep Both: create a new note in your Highlights folder and keep the existing note where it is.\n" +
					"• Replace: overwrite the existing note in its current location with newly imported content.\n" +
					"• Skip: take no action for this book right now.";
			}
		}

		return ok(promptMessage);
	} catch (e) {
		return err(e as Error);
	}
}
