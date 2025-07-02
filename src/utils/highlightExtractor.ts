import type { Annotation } from "src/types";

export function extractHighlights(content: string): Annotation[] {
	const highlights: Annotation[] = [];
	let currentChapter = "";

	// A pattern that identifies a highlight block, starting with the metadata.
	const highlightBlockRegex =
		/\(\*Date:\s*(.+?)\s*-\s*Page:\s*(.+?)\s*\*\)\r?\n([\s\S]*?)(?=---|$)/g;

	const lines = content.split(/\r?\n/);
	let blockContent = "";

	// First, find all chapter definitions and their line numbers.
	const chapterDeclarations = new Map<number, string>();
	lines.forEach((line, index) => {
		const chapterMatch = line.match(/^### Chapter:\s*(.+)/);
		if (chapterMatch) {
			chapterDeclarations.set(index, chapterMatch[1].trim());
		}
	});

	const matches = content.matchAll(highlightBlockRegex);

	for (const match of matches) {
		// Find the line number where this match starts.
		const matchIndex = match.index ?? 0;
		const contentUpToMatch = content.substring(0, matchIndex);
		const startLine = contentUpToMatch.split(/\r?\n/).length - 1;

		// Determine the current chapter based on the match's position.
		let chapterForThisHighlight = "";
		// Find the most recent chapter declaration that occurred *before* this highlight.
		for (const [lineNum, chapterName] of chapterDeclarations.entries()) {
			if (lineNum < startLine) {
				chapterForThisHighlight = chapterName;
			} else {
				break; // Stop once we pass the highlight's position
			}
		}

		const [, datetime, pageStr, textBlock] = match;
		const pageNum = Number.parseInt(pageStr, 10);

		highlights.push({
			chapter: chapterForThisHighlight,
			datetime: datetime.trim(),
			pageno: Number.isFinite(pageNum) ? pageNum : 0,
			text: textBlock.trim(),
		});
	}

	return highlights;
}
