import type { Annotation } from "./types";
import { compareAnnotations } from "./utils/formatUtils";

export function extractHighlights(content: string): Annotation[] {
  const highlights: Annotation[] = [];

  // This regex finds all highlight blocks in the text.
  const highlightBlockRegex =
    /(?:### Chapter:\s*(.+)\r?\n)?\(\*Date:\s*(.+?)\s*-\s*Page:\s*(.+?)\s*\*\)\r?\n([\s\S]*?)(?=---|$)/g;

  const matches = content.matchAll(highlightBlockRegex);

  for (const match of matches) {
    const [, chapter, datetime, pageStr, textBlock] = match;

    const pageNum = Number.parseInt(pageStr, 10);

    highlights.push({
      chapter: chapter?.trim() || "",
      datetime: datetime.trim(),
      pageno: Number.isFinite(pageNum) ? pageNum : 0,
      text: textBlock.trim(),
    });
  }

  return highlights;
}

function finalizeHighlight(
  highlight: Partial<Annotation> | null,
  textLines: string[],
  highlights: Annotation[],
) {
  if (!highlight) return;

  const text = textLines.join("\n").trim();

  if (!text) {
    return;
  }

  highlights.push({
    chapter: highlight.chapter?.trim() || "",
    datetime: highlight.datetime || new Date().toISOString(),
    pageno: (highlight.pageno === undefined || Number.isNaN(highlight.pageno))
      ? 0
      : highlight.pageno,
    text: text,
  });
}

// Helper to create a consistent key for a highlight
const getHighlightKey = (h: Annotation): string => {
  // Use a delimiter that is unlikely to appear in the text itself
  const keyParts = [
    h.chapter || "",
    h.pageno,
    (h.text || "").trim().replace(/\s+/g, " ").toLowerCase(), // Normalize text for key (trim, collapse whitespace, lowercase)
  ];
  return keyParts.join("|||");
};

export function mergeHighlights(
  existing: Annotation[],
  newHighlights: Annotation[],
  isTextEqual: (text1: string, text2: string) => boolean,
): Annotation[] {
  const merged = [...existing];

  // Create a Set of keys from existing highlights for O(1) lookup.
  const existingKeys = new Set<string>(existing.map(getHighlightKey));

  for (const newHighlight of newHighlights) {
    const key = getHighlightKey(newHighlight);
    if (!existingKeys.has(key)) {
      merged.push(newHighlight);
      // Add the new key to the set to handle duplicates within newHighlights itself
      existingKeys.add(key);
    }
  }

  // Sort the merged array using compareAnnotations (assuming it exists)
  return merged.sort(compareAnnotations);
}
