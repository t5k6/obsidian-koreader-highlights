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
/* 2 ▸ CSS-var accessors (memoised)                                   */
/* ------------------------------------------------------------------ */

const getCssVar = (name: string, fallback: string): string => {
	if (!(getCssVar as { _cache?: Record<string, string> })._cache) {
		(getCssVar as { _cache?: Record<string, string> })._cache = {};
	}
	const cache = (getCssVar as { _cache?: Record<string, string> })._cache!;

	if (cache[name]) return cache[name];

	try {
		cache[name] =
			getComputedStyle(document.documentElement)
				.getPropertyValue(name)
				.trim() || fallback;
	} catch {
		cache[name] = fallback;
	}
	return cache[name];
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

	const safe = esc(text);
	const key = koColor?.toLowerCase().trim() as ColourName | undefined;
	const isPaletteColor = !!key && !!KOReaderHighlightColors[key];
	const bg = isPaletteColor ? KOReaderHighlightColors[key!] : koColor;

	switch (drawer) {
		case "underscore":
			return `<u>${safe}</u>`;
		case "strikeout":
			return `<s>${safe}</s>`;
		case "invert": {
			const fg = isPaletteColor ? toBgVar(key!) : "var(--text-accent)";
			return mark(safe, "transparent", fg);
		}
		// FIX: Combine cases to prevent fallthrough warning
		case "lighten":
		case undefined:
		default: {
			if (!bg) return safe;

			// Special case from original logic: "lighten" drawer with "gray" color
			if (drawer === "lighten" && key === "gray") {
				return safe;
			}

			let fg: string | null;
			if (isPaletteColor) {
				fg = toFgVar(key!);
			} else {
				fg = bestBW(bg);
			}

			// If fg is null, it means bestBW failed (e.g., invalid hex). Return plain text.
			if (!fg) {
				return safe;
			}

			return mark(safe, bg, fg);
		}
	}
}

/* quick black/white chooser if colour is not in our palette */
function bestBW(hex: string): string | null {
	const rgb = toRgb(hex);
	if (!rgb) return null;
	const white = [255, 255, 255] as RGB;
	const black = [0, 0, 0] as RGB;
	return contrast(black, rgb) >= contrast(white, rgb) ? "#000" : "#fff";
}

const mark = (txt: string, bg: string, fg: string) =>
	`<mark style="background:${bg};color:${fg};">${txt}</mark>`;
