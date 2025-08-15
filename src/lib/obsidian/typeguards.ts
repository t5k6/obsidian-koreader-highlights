import type { TAbstractFile, TFile, TFolder } from "obsidian";

/**
 * Narrow to Obsidian's abstract file shape.
 */
export function isTAbstractFile(x: unknown): x is TAbstractFile {
	return (
		!!x &&
		typeof x === "object" &&
		typeof (x as any).path === "string" &&
		typeof (x as any).name === "string" &&
		"vault" in (x as any)
	);
}

/**
 * Robust structural check for TFile.
 * - Must be an abstract file.
 * - Has string `extension`.
 * - Has a `stat` object with numeric `mtime` (stable across Obsidian versions).
 * - Must NOT have `children` (excludes folders).
 */
export function isTFile(x: TAbstractFile | unknown): x is TFile {
	if (!isTAbstractFile(x)) return false;
	const f = x as any;
	return (
		typeof f.extension === "string" &&
		!!f.stat &&
		typeof f.stat === "object" &&
		typeof f.stat.mtime === "number" &&
		!("children" in f)
	);
}

/**
 * Robust structural check for TFolder.
 * - Must be an abstract file.
 * - Has `children` array.
 */
export function isTFolder(x: TAbstractFile | unknown): x is TFolder {
	if (!isTAbstractFile(x)) return false;
	const f = x as any;
	return Array.isArray(f.children) || false;
}

/**
 * Common convenience guard for markdown files.
 */
export function isMarkdownFile(x: TAbstractFile | unknown): x is TFile {
	return (
		isTFile(x) &&
		typeof x.extension === "string" &&
		x.extension.toLowerCase() === "md"
	);
}
