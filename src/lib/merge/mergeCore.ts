import { err, ok, type Result } from "src/lib/core/result";
import type {
	DuplicateMatch,
	KoreaderHighlightImporterSettings,
} from "src/types";
import { formatConflictRegions, performDiff3 } from "./diffCore";

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

/**
 * Pure 3-way text merge.
 * @param baseBody The content of the common ancestor (snapshot).
 * @param currentBody The content currently in the vault (local).
 * @param incomingBody The new content from KOReader (remote).
 */
export function mergeNoteBodies(
	baseBody: string,
	currentBody: string,
	incomingBody: string,
): { mergedBody: string; hasConflict: boolean } {
	const regions = performDiff3(currentBody, baseBody, incomingBody);
	const result = formatConflictRegions(regions);

	// Safety Heuristic: Force conflict if incoming is empty but local has grown,
	// preventing accidental deletion of user content if parsing failed silently upstream.
	if (
		!result.hasConflict &&
		incomingBody.trim() === "" &&
		currentBody.trim() !== "" &&
		currentBody.length > baseBody.length
	) {
		// Synthesize a full-file conflict to force user review
		const globalConflict = [
			{
				conflict: {
					a: currentBody.split("\n"),
					aIndex: 0,
					b: [],
					bIndex: 0,
					o: baseBody.split("\n"),
					oIndex: 0,
				},
			},
		];
		const safetyResult = formatConflictRegions(globalConflict);
		return { mergedBody: safetyResult.mergedBody, hasConflict: true };
	}

	return result;
}
