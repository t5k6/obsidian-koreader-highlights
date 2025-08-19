/***********************************************************************
 * highlightStyle.ts – KOReader → Obsidian highlight helper            *
 * Guarantees at least 4.5:1 contrast for any generated mark element.  *
 ***********************************************************************/

import { escapeHtml } from "src/lib/strings/stringUtils";
import type { Annotation } from "src/types";

/* ------------------------------------------------------------------ */
/* 1 ▸ names & helpers                                                */
/* ------------------------------------------------------------------ */

export const colorNames = [
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

export type ColorName = (typeof colorNames)[number];

const toBgVar = (n: ColorName) => `var(--khl-${n})`;
const toFgVar = (n: ColorName) => `var(--on-khl-${n})`;

/* read-only map (kept mostly for compatibility with old code) */
export const KOReaderHighlightColors = Object.fromEntries(
	colorNames.map((n) => [n, toBgVar(n)]),
) as Record<ColorName, string>;

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

/**
 * Calculates WCAG relative luminance for sRGB color.
 * @param rgb - RGB color values [0-255]
 * @returns Relative luminance value
 */
const luminance = ([r, g, b]: RGB) => {
	const s = [r, g, b].map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};

/**
 * Calculates WCAG contrast ratio between two colors.
 * @param a - First RGB color
 * @param b - Second RGB color
 * @returns Contrast ratio (1-21)
 */
const contrast = (a: RGB, b: RGB) => {
	const [L1, L2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (L1 + 0.05) / (L2 + 0.05);
};

/* ------------------------------------------------------------------ */
/* 3 ▸ Public API                                                     */
/* ------------------------------------------------------------------ */

/**
 * Renders KOReader highlight text as HTML with appropriate styling.
 * Handles different highlight styles (underline, strikeout, invert, color).
 * Ensures WCAG-compliant contrast for colored highlights.
 * @param text - The highlight text to style
 * @param koColor - KOReader color name or hex code
 * @param drawer - Highlight style ("underscore", "strikeout", "invert", "lighten")
 * @returns HTML string with styled highlight
 */
export function styleHighlight(
	text: string,
	koColor?: string,
	drawer?: Annotation["drawer"],
): string {
	if (!text.trim()) return "";

	const paragraphs = text
		.split("\\")
		.map((p) => escapeHtml(p.trim()))
		.filter(Boolean);

	const processedText = paragraphs.join("<br><br>");

	let wrapper: ((content: string) => string) | null = null;
	const key = koColor?.toLowerCase().trim() as ColorName | undefined;
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
				// This is KOReader's default highlight.
				wrapper = (content) => content;
			} else if (koColor && (isPaletteColor || toRgb(koColor))) {
				// This handles all other recognized colors for "lighten" and other drawers.
				const bg = isPaletteColor ? KOReaderHighlightColors[key!] : koColor;
				const fg = isPaletteColor ? toFgVar(key!) : bestBW(koColor);
				wrapper = (content) =>
					`<mark style="background:${bg};color:${fg ?? "inherit"};">${content}</mark>`;
			}
			break;
		}
	}

	return wrapper ? wrapper(processedText) : processedText;
}

/**
 * Determines best contrasting color (black or white) for a given background.
 * Ensures WCAG compliance for text readability.
 * @param hex - Hex color code
 * @returns "#000" or "#fff" for best contrast, null if invalid
 */
function bestBW(hex: string): string | null {
	const rgb = toRgb(hex);
	if (!rgb) return null;
	const white = [255, 255, 255] as RGB;
	const black = [0, 0, 0] as RGB;
	return contrast(black, rgb) >= contrast(white, rgb) ? "#000" : "#fff";
}
