import type { Annotation } from "./types";

export function extractHighlights(content: string): Annotation[] {
  const highlights: Annotation[] = [];
  const lines = content.split("\n");
  let currentHighlight: Partial<Annotation> | null = null;
  let collectingText = false;
  let currentText: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line === "---") {
      while (i < lines.length && lines[i] !== "---") i++;
      continue;
    }

    const chapterMatch = line.match(/^### Chapter: (.+)$/);
    if (chapterMatch) {
      finalizeHighlight(currentHighlight, currentText, highlights);
      currentHighlight = { chapter: chapterMatch[1] };
      currentText = [];
      continue;
    }

    const metadataMatch = line.match(/^\(\*Date: (.+) - Page: (\d+)\*\)$/);
    if (metadataMatch && currentHighlight) {
      currentHighlight.datetime = metadataMatch[1];
      currentHighlight.pageno = Number.parseInt(metadataMatch[2], 10);
      collectingText = true;
      continue;
    }

    if (line === "---") {
      finalizeHighlight(currentHighlight, currentText, highlights);
      currentHighlight = null;
      collectingText = false;
      currentText = [];
      continue;
    }

    if (collectingText && currentHighlight && line.trim()) {
      currentText.push(line);
    }
  }

  finalizeHighlight(currentHighlight, currentText, highlights);
  return highlights;
}

function finalizeHighlight(
  highlight: Partial<Annotation> | null,
  textLines: string[],
  highlights: Annotation[],
) {
  if (!highlight) return;

  highlights.push({
    chapter: highlight.chapter || "",
    datetime: highlight.datetime || new Date().toISOString(),
    pageno: highlight.pageno || 0,
    text: textLines.join("\n").trim(),
  });
}

export function mergeHighlights(
  existing: Annotation[],
  newHighlights: Annotation[],
  isTextEqual: (a: string, b: string) => boolean,
): Annotation[] {
  const merged = [...existing];
  for (const newHighlight of newHighlights) {
    const exists = merged.some((eh) =>
      eh.chapter === newHighlight.chapter &&
      eh.pageno === newHighlight.pageno &&
      isTextEqual(eh.text || "", newHighlight.text || "")
    );
    if (!exists) merged.push(newHighlight);
  }
  return merged.sort((a, b) => a.pageno - b.pageno);
}
