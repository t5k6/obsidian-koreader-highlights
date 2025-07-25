/***********************************************************************
 * highlightStyle.ts – KOReader → Obsidian highlight helper            *
 * Guarantees at least 4.5:1 contrast for any generated mark element.  *
 ***********************************************************************/

import type { Annotation } from "../types";

/* ------------------------------------------------------------------ */
/* 1 ▸ names & helpers                                                */
/* ------------------------------------------------------------------ */

export const colourNames = [
	"red",
	"orange",
	"yellow",
	"green",
	"olive",
	"cyan",
	"blue",
	"purple",
	"gray",
] as const;

export type ColourName = (typeof colourNames)[number];

const toBgVar = (n: ColourName) => `var(--khl-${n})`;
const toFgVar = (n: ColourName) => `var(--on-khl-${n})`;

/* read-only map (kept mostly for compatibility with old code) */
export const KOReaderHighlightColors = Object.fromEntries(
	colourNames.map((n) => [n, toBgVar(n)]),
) as Record<ColourName, string>;

const RAW_HEX3 = /^#?([\da-f])([\da-f])([\da-f])$/i;
const RAW_HEX6 = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

type RGB = [number, number, number];
const toRgb = (hex: string): RGB | null => {
	const m3 = RAW_HEX3.exec(hex);
	if (m3) return m3.slice(1).map((x) => parseInt(x + x, 16)) as RGB;

	const m6 = RAW_HEX6.exec(hex);
	if (m6) return m6.slice(1).map((x) => parseInt(x, 16)) as RGB;

	return null;
};

/** WCAG relative luminance (sRGB) */
const luminance = ([r, g, b]: RGB) => {
	const s = [r, g, b].map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};

const contrast = (a: RGB, b: RGB) => {
	const [L1, L2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (L1 + 0.05) / (L2 + 0.05);
};

/* ------------------------------------------------------------------ */
/* 3 ▸ Public API                                                     */
/* ------------------------------------------------------------------ */

const ESC_MAP: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);

/**
 * Render a KOReader highlight → HTML (`<mark>` / `<u>` / etc.)
 */
export function styleHighlight(
	text: string,
	koColor?: string,
	drawer?: Annotation["drawer"],
): string {
	if (!text.trim()) return "";

	// 1. Process paragraphs using the now-confirmed backslash separator.
	const paragraphs = text
		// In a JS string literal, a single backslash is written as '\\'.
		.split("\\")
		.map((p) => esc(p.trim())) // Trim whitespace from each paragraph and escape it.
		.filter(Boolean); // Remove any empty paragraphs resulting from the split.

	// Join with inline-safe <br><br> to create visual paragraph breaks.
	const processedText = paragraphs.join("<br><br>");

	// 2. Determine the wrapper function. Default to no wrapper.
	let wrapper: ((content: string) => string) | null = null;
	const key = koColor?.toLowerCase().trim() as ColourName | undefined;
	const isPaletteColor = !!key && !!KOReaderHighlightColors[key];

	switch (drawer) {
		case "underscore":
			wrapper = (content) => `<u>${content}</u>`;
			break;
		case "strikeout":
			wrapper = (content) => `<s>${content}</s>`;
			break;
		case "invert": {
			const fg = isPaletteColor ? toBgVar(key!) : "var(--text-accent)";
			wrapper = (content) =>
				`<mark style="background:transparent;color:${fg};">${content}</mark>`;
			break;
		}
		case "lighten":
		case undefined:
		default: {
			if (drawer === "lighten" && key === "gray") {
				break;
			}
			if (koColor) {
				const bg = isPaletteColor ? KOReaderHighlightColors[key!] : koColor;
				const fg = isPaletteColor ? toFgVar(key!) : bestBW(koColor);
				wrapper = (content) =>
					`<mark style="background:${bg};color:${fg ?? "inherit"};">${content}</mark>`;
			}
			break;
		}
	}

	// 3. Apply the wrapper if determined, otherwise return the processed plain text.
	return wrapper ? wrapper(processedText) : processedText;
}
/* quick black/white chooser if colour is not in our palette */
function bestBW(hex: string): string | null {
	const rgb = toRgb(hex);
	if (!rgb) return null;
	const white = [255, 255, 255] as RGB;
	const black = [0, 0, 0] as RGB;
	return contrast(black, rgb) >= contrast(white, rgb) ? "#000" : "#fff";
}
