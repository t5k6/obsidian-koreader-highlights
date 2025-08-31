import type { TFile } from "obsidian";

export function createExtensionFilter(
	extensions: string[],
): (file: TFile) => boolean {
	const normalized = new Set(
		extensions.map((e) => e.replace(/^\./, "").toLowerCase()),
	);
	return (file: TFile) => {
		const ext = file.extension?.toLowerCase();
		return !!ext && normalized.has(ext);
	};
}
