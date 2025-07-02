import type { Annotation } from "../types";

/* ---------- KOReader colour tables ---------- */

export const KOReaderHighlightColors: Record<string, string> = {
	red: "#ff0000",
	orange: "#ff9900",
	yellow: "#ffff00",
	green: "#00ff00",
	olive: "#808000",
	cyan: "#00ffff",
	blue: "#0000ff",
	purple: "#800080",
	gray: "#808080",
};

export const KOReaderTextColors: Record<
	string,
	{ light: string; dark: string }
> = {
	red: { light: "#fff", dark: "#fff" },
	orange: { light: "#000", dark: "#fff" },
	yellow: { light: "#000", dark: "#000" },
	green: { light: "#000", dark: "#fff" },
	olive: { light: "#fff", dark: "#fff" },
	cyan: { light: "#000", dark: "#000" },
	blue: { light: "#fff", dark: "#fff" },
	purple: { light: "#fff", dark: "#fff" },
	gray: { light: "#000", dark: "#fff" },
};

/* ---------- helper maths ---------- */
export function hexToRgb(hex: string): [number, number, number] | null {
	const match = hex.replace("#", "").match(/.{1,2}/g);
	if (!match || match.length < 3) return null;
	return [
		Number.parseInt(match[0], 16),
		Number.parseInt(match[1], 16),
		Number.parseInt(match[2], 16),
	];
}
export function luminance([r, g, b]: [number, number, number]): number {
	const a = [r, g, b].map((v) => {
		const n = v / 255;
		return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}

export function getContrastTextColor(
	bgColor: string,
	isDarkTheme: boolean,
): string {
	if (!bgColor) return isDarkTheme ? "#fff" : "#222";
	const lc = bgColor.toLowerCase();

	if (KOReaderTextColors[lc]) {
		return isDarkTheme
			? KOReaderTextColors[lc].dark
			: KOReaderTextColors[lc].light;
	}

	const colorHex = KOReaderHighlightColors[lc] || bgColor;
	if (!colorHex.startsWith("#")) return isDarkTheme ? "#fff" : "#222";

	const rgb = hexToRgb(colorHex);
	if (!rgb) return isDarkTheme ? "#fff" : "#222";

	const lum = luminance(rgb);
	return lum > 0.5 ? "#222" : "#fff";
}

/* ---------- main public API ---------- */
function createStyledMark(
	text: string,
	backgroundColor: string,
	textColor: string,
): string {
	return `<mark style="background-color: ${backgroundColor}; color: ${textColor};">${text}</mark>`;
}

function createInvertedHighlight(
	text: string,
	colorHex: string | null,
	isDarkTheme: boolean,
): string {
	if (!colorHex) return text;
	const textColor = getContrastTextColor(colorHex, isDarkTheme);
	return createStyledMark(text, "transparent", textColor);
}

function createStandardHighlight(
	text: string,
	colorHex: string | null,
	isDarkTheme: boolean,
): string {
	if (!colorHex) return text; // remain raw for grey/unknown
	const textColor = getContrastTextColor(colorHex, isDarkTheme);
	return createStyledMark(text, colorHex, textColor);
}

export function styleHighlight(
	text: string,
	color?: string,
	drawer?: Annotation["drawer"],
	isDarkTheme = false,
): string {
	if (!text?.trim()) return "";

	const lc = color?.toLowerCase().trim();
	const colorHex =
		lc != null ? (KOReaderHighlightColors[lc] ?? color ?? null) : null;

	switch (drawer) {
		case "underscore":
			return `<u>${text}</u>`;
		case "strikeout":
			return `<s>${text}</s>`;
		case "invert":
			return createInvertedHighlight(text, colorHex, isDarkTheme);
		case "lighten":
			if (colorHex === "#808080" || lc === "gray") return text;
			return createStandardHighlight(text, colorHex, isDarkTheme);
		default:
			return createStandardHighlight(text, colorHex, isDarkTheme);
	}
}
