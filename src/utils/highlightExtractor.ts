import type { Annotation } from "../types";

const KOHL_MARKER_REGEX = /<!--\s*KOHL\s*({.*?})\s*-->/g;

function safeParseJson(json: string): any | null {
	try {
		return JSON.parse(json);
	} catch {
		return null;
	}
}

function splitTextAndNote(block: string): { text: string; note?: string } {
	const lines = block.split(/\r?\n/);
	const noteIndex = lines.findIndex((l) => l.trim().startsWith(">"));
	if (noteIndex === -1) return { text: block };
	const text = lines.slice(0, noteIndex).join("\n").trim();
	const note = lines
		.slice(noteIndex)
		.map((l) => l.replace(/^\s*>?\s*/, ""))
		.join("\n")
		.trim();
	return { text, note };
}

export function extractHighlights(md: string): Annotation[] {
	const annotations: Annotation[] = [];
	const matches = Array.from(md.matchAll(KOHL_MARKER_REGEX));

	if (matches.length === 0) {
		return [];
	}

	for (let i = 0; i < matches.length; i++) {
		const match = matches[i];
		const meta = safeParseJson(match[1]);
		if (!meta || !meta.id) continue;

		const startPos = match.index! + match[0].length;
		const endPos = matches[i + 1] ? matches[i + 1].index! : md.length;
		const visibleText = md.slice(startPos, endPos).trim();
		const { text, note } = splitTextAndNote(visibleText);

		annotations.push({
			id: meta.id,
			pageno: meta.p,
			pos0: meta.pos0,
			pos1: meta.pos1,
			datetime: meta.t,
			text: text,
			note: note,
		});
	}
	return annotations;
}
