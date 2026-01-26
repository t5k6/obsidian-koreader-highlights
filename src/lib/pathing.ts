import path, { parse, posix as posixPath } from "node:path";
import { normalizePath } from "obsidian";
import { FILENAME_TRUNCATION_HASH_LENGTH } from "src/constants";
import { formatDateForDailyNote } from "src/lib/formatting/dateUtils";
import {
	normalizeWhitespace as stringNormalizeWhitespace,
	stripDiacritics as stringStripDiacritics,
} from "src/lib/strings/stringUtils";
import type { DocProps } from "src/types";
import { sha1Hex } from "./core/crypto";

/* ------------------------------------------------------------------ */
/*                           BRANDED TYPES                           */
/* ------------------------------------------------------------------ */

/**
 * Branded type for vault-relative paths.
 * These are paths normalized for use within Obsidian vaults:
 * - Use forward slashes
 * - No leading or trailing slashes (except root)
 * - Relative to vault root
 */
export type VaultPath = string & { __brand: "VaultPath" };

/**
 * Branded type for OS-native system paths.
 * These are absolute paths on the file system:
 * - May use backslashes on Windows
 * - Absolute paths with drive letters or root slash
 * - Used for external file operations
 */
export type SystemPath = string & { __brand: "SystemPath" };

/**
 * Type guard to check if a string is already a VaultPath.
 * Note: This is a runtime no-op but helps with type checking.
 */
export function isVaultPath(path: string): path is VaultPath {
	return true; // Runtime check not feasible for branded types
}

/**
 * Type guard to check if a string is already a SystemPath.
 * Note: This is a runtime no-op but helps with type checking.
 */
export function isSystemPath(path: string): path is SystemPath {
	return true; // Runtime check not feasible for branded types
}

/**
 * Convert a VaultPath to a string for compatibility with APIs that expect raw strings.
 * Use sparingly - prefer keeping the branded type when possible.
 */
export function vaultPathToString(path: VaultPath): string {
	return path as string;
}

/**
 * Convert a SystemPath to a string for compatibility with APIs that expect raw strings.
 * Use sparingly - prefer keeping the branded type when possible.
 */
export function systemPathToString(path: SystemPath): string {
	return path as string;
}

// ================================================================
// Core Types
// ================================================================

export type FileSafeOptions = {
	maxLength?: number; // default 0 (disabled)
	lower?: boolean; // default false
	ascii?: boolean; // default false (keep diacritics by default to preserve readability)
	allowUnicode?: boolean; // default true (when ascii=true and allowUnicode=false, coerce non-ASCII)
	fallback?: string; // default "untitled"
};

export type MatchKeyOptions = {
	lower?: boolean; // default true
	ascii?: boolean; // default true
	collapse?: boolean; // default true
};

export type FileNameTemplateOptions = {
	useCustomTemplate: boolean;
	template: string;
};

export interface ScanCacheKey {
	rootPath: VaultPath;
	extensions: string[];
	recursive: boolean;
}

// ================================================================
// Internal Helpers
// ================================================================

function normalizeFileSafeOpts(opts?: FileSafeOptions) {
	return {
		maxLength: opts?.maxLength ?? 0,
		lower: opts?.lower ?? false,
		ascii: opts?.ascii ?? false,
		allowUnicode: opts?.allowUnicode ?? true,
		fallback: opts?.fallback ?? "untitled",
	};
}

function normalizeMatchKeyOpts(opts?: MatchKeyOptions) {
	return {
		lower: opts?.lower ?? true,
		ascii: opts?.ascii ?? false, // Default to false to support multi-language keys
		collapse: opts?.collapse ?? true,
	};
}

/** Remove characters forbidden on Windows/macOS filesystems; also drop control chars. */
function removeIllegalFsChars(s: string): string {
	// Windows: <>:"/\|?* and 0x00-0x1F; also DEL
	// 1) Strip forbidden punctuation via regex (safe)
	const withoutPunct = s.replace(/[<>:"/\\|?*]/g, "_");
	// 2) Drop control characters programmatically to satisfy Biome rule
	let out = "";
	for (let i = 0; i < withoutPunct.length; i++) {
		const ch = withoutPunct[i]!;
		const code = ch.charCodeAt(0);
		if ((code >= 0 && code <= 31) || code === 127) continue;
		out += ch;
	}
	return out;
}

/** Prevent reserved path segments on Windows and "." / "..". */
function avoidReservedNames(s: string): string {
	const trimmed = s.replace(/[. ]+$/g, ""); // no trailing dot/space
	const lower = trimmed.toLowerCase();
	const reserved = new Set([
		"con",
		"prn",
		"aux",
		"nul",
		"com1",
		"com2",
		"com3",
		"com4",
		"com5",
		"com6",
		"com7",
		"com8",
		"com9",
		"lpt1",
		"lpt2",
		"lpt3",
		"lpt4",
		"lpt5",
		"lpt6",
		"lpt7",
		"lpt8",
		"lpt9",
		".",
		"..",
	]);
	return reserved.has(lower) ? `_${trimmed}` : trimmed;
}

// ================================================================
// Public Pure Functions
// ================================================================

/**
 * Converts a string to a filesystem-safe format by removing illegal characters,
 * normalizing whitespace, and optionally applying transformations like lowercasing.
 * This is a pure function with no caching.
 */
export function toFileSafe(
	input: string | null | undefined,
	opts?: FileSafeOptions,
): string {
	const o = normalizeFileSafeOpts(opts);
	let s = String(input ?? "").trim();
	if (!s) return o.fallback;

	s = stringNormalizeWhitespace(s);
	// Preserve original punctuation as much as possible.
	// Only coerce typographic apostrophes/quotes to ASCII when we're explicitly
	// in an ASCII-only mode.
	if (o.ascii || !o.allowUnicode) {
		s = s.replace(/[\u2018\u2019\u02BC\uFF07]/g, "'");
	}
	if (o.ascii) {
		s = stringStripDiacritics(s);
		if (!o.allowUnicode) {
			s = s.replace(/[^\w\s.-]/g, "_");
		}
	}
	s = removeIllegalFsChars(s);
	// Allow common punctuation including straight and typographic apostrophes.
	s = s.replace(/[^\p{L}\p{N} .,_()'’-]/gu, "_").replace(/_+/g, "_");
	s = s.replace(/\s+/g, " ").trim();
	if (o.lower) s = s.toLowerCase();
	s = avoidReservedNames(s);
	if (o.maxLength > 0 && s.length > o.maxLength) {
		s = s.slice(0, o.maxLength).trim();
	}
	return s || o.fallback;
}

/**
 * Converts a string to a normalized match key for fuzzy comparisons.
 * Strips special characters, normalizes whitespace, and optionally lowercases.
 * This is a pure function with no caching.
 */
export function toMatchKey(
	input: string | null | undefined,
	opts?: MatchKeyOptions,
): string {
	const o = normalizeMatchKeyOpts(opts);
	let s = String(input ?? "").trim();
	if (!s) return "";

	if (o.collapse) s = stringNormalizeWhitespace(s);
	// Use normalized option: defaults to false now
	if (o.ascii) s = stringStripDiacritics(s);

	// Use Unicode property escapes to keep letters and numbers from any language
	s = s.replace(/[^\p{L}\p{N}]+/gu, " ");

	if (o.collapse) s = s.replace(/\s+/g, " ").trim();
	if (o.lower) s = s.toLowerCase();
	return s || "untitled";
}

/**
 * Normalizes whitespace in a string (delegates to stringUtils).
 */
export function normalizeWhitespace(s: string): string {
	return stringNormalizeWhitespace(s);
}

/**
 * Converts a path to a canonical, vault-relative format.
 * Single source of truth for vault path normalization.
 */
export function toVaultPath(rawPath: string | null | undefined): VaultPath {
	if (!rawPath) return "" as VaultPath;
	const p = normalizePath(String(rawPath).trim());
	if (p === "/" || p === "." || p === "") return "" as VaultPath;
	return p.replace(/^\/+/, "").replace(/\/+$/, "") as VaultPath;
}

/** Basename (final segment) of a vault path string. */
export function vaultBasenameOf(p: VaultPath | string): string {
	const norm = typeof p === "string" ? toVaultPath(p) : p;
	const parts = norm.split("/");
	return parts[parts.length - 1] ?? "";
}

/** Returns the parent directory of a vault path. */
export function vaultDirname(vaultPath: VaultPath | string): VaultPath {
	const normalized =
		typeof vaultPath === "string" ? toVaultPath(vaultPath) : vaultPath;
	const parent = posixPath.dirname(normalized);
	return (parent === "." ? "" : parent) as VaultPath;
}

/** Extension (including dot) of a vault path's basename, or empty string. */
export function vaultExtnameOf(p: VaultPath | string): string {
	const base = vaultBasenameOf(p as VaultPath);
	const idx = base.lastIndexOf(".");
	return idx >= 0 ? base.slice(idx) : "";
}

/** Returns true if ancestor is the same as or a parent of child (vault path semantics). */
export function isAncestor(
	ancestor: VaultPath | string,
	child: VaultPath | string,
): boolean {
	const ancestorNorm =
		typeof ancestor === "string" ? toVaultPath(ancestor) : ancestor;
	const childNorm = typeof child === "string" ? toVaultPath(child) : child;
	if (ancestorNorm === "") return true; // vault root is ancestor of everything
	if (ancestorNorm === childNorm) return true;
	return childNorm.startsWith(`${ancestorNorm}/`);
}

/**
 * Simplifies KOReader SDR directory names to human-readable format.
 * Removes series prefixes, duplicate tokens, and duplicate blocks.
 * Case-insensitive but preserves first spelling encountered.
 */
export function simplifySdrName(raw: string, delimiter = " - "): string {
	if (!raw) {
		return "";
	}

	// ── 0. Strip a prepended "(……)" leader.
	raw = raw.replace(/^\([^)]*\)\s*/, "").trim();

	const parts = raw
		.split(delimiter)
		.map((p) => p.trim())
		.filter(Boolean);

	// ── 1. Drop REPEATED TOKENS (case-insensitive, preserve first spelling)
	const seen = new Set<string>();
	const uniq: string[] = [];
	for (const p of parts) {
		const key = p.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			uniq.push(p);
		}
	}

	// ── 2. Drop REPEATED BLOCKS (A B C A B C → A B C)
	const tokens = [...uniq];
	let changed = true;
	while (changed) {
		changed = false;
		for (
			let blockLen = Math.floor(tokens.length / 2);
			blockLen >= 1;
			blockLen--
		) {
			for (let i = 0; i <= tokens.length - 2 * blockLen; i++) {
				const block1 = tokens.slice(i, i + blockLen);
				const block2 = tokens.slice(i + blockLen, i + 2 * blockLen);
				if (
					block1.every(
						(val, index) => val.toLowerCase() === block2[index].toLowerCase(),
					)
				) {
					tokens.splice(i + blockLen, blockLen);
					changed = true;
					break; // Restart scan with modified array
				}
			}
			if (changed) break;
		}
	}

	const finalName = tokens.join(delimiter);
	// If the resulting name contains no letters or numbers, it's likely not a real title.
	if (finalName && !/[a-zA-Z0-9]/.test(finalName)) {
		return "Untitled";
	}
	return finalName || "Untitled";
}

/** Extracts filename without extension from a file path. */
export function getFileNameWithoutExt(filePath: string | undefined): string {
	if (!filePath) return "";
	return parse(filePath).name;
}

/** Generates a sanitized .md filename based on template or defaults. */
export function generateFileName(
	options: FileNameTemplateOptions,
	docProps: DocProps,
	originalSdrName?: string,
): string {
	let baseName: string;

	if (options.useCustomTemplate) {
		const templateData: Record<string, string> = {
			title: docProps.title?.trim() || "Untitled",
			authors: docProps.authors?.trim() || "Unknown Author",
			importDate: formatDateForDailyNote(),
		};
		baseName = options.template.replace(
			/\{\{(\w+)\}\}/g,
			(_, key) => templateData[key] || "",
		);
	} else {
		baseName = generateDefaultBaseName(docProps, originalSdrName);
	}

	if (!baseName?.trim()) {
		baseName =
			simplifySdrName(getFileNameWithoutExt(originalSdrName)) || "Untitled";
	}

	const sanitized = toFileSafe(baseName, {
		fallback: "Untitled",
		maxLength: 0,
	});
	return `${sanitized}.md`;
}

function generateDefaultBaseName(
	docProps: DocProps,
	originalSdrName?: string,
): string {
	const title = docProps.title?.trim();
	const authors = docProps.authors?.trim();
	const sdrBase = simplifySdrName(getFileNameWithoutExt(originalSdrName));
	if (authors && title) return `${authors} - ${title}`;
	if (authors) return `${authors} - ${sdrBase}`;
	if (title) return title;
	return sdrBase || "Untitled";
}

/** Validates a filename template string for allowed placeholders. */
export function validateFileNameTemplate(template: string): {
	isValid: boolean;
	errors: string[];
	warnings: string[];
} {
	const result = {
		isValid: true,
		errors: [] as string[],
		warnings: [] as string[],
	};
	const valid = new Set(["title", "authors", "importDate"]);

	const placeholders = [...template.matchAll(/\{\{(\w+)\}\}/g)].map(
		(m) => m[1],
	);

	if (placeholders.length === 0 && template.trim()) {
		result.warnings.push(
			"Template has no placeholders like {{title}}. The filename will be static.",
		);
	} else {
		for (const p of placeholders) {
			if (!valid.has(p)) {
				result.errors.push(`Invalid placeholder: {{${p}}}`);
				result.isValid = false;
			}
		}
	}

	if (
		result.isValid &&
		!placeholders.includes("title") &&
		!placeholders.includes("authors")
	) {
		result.warnings.push(
			"It's recommended to include {{title}} or {{authors}} to ensure unique filenames.",
		);
	}

	return result;
}

export function computeStemBudget(
	absVaultBase: string | null,
	vaultFolder: string,
	extensionWithDot: string,
	targetMaxPathLen: number,
	suffixReserve: number,
): number {
	const sep = absVaultBase && absVaultBase.includes("\\") ? "\\" : "/";
	const folder = String(vaultFolder || "").replace(/^[/]+|[/]+$/g, "");
	const fixedParts = [absVaultBase ?? "", folder].filter(Boolean).join(sep);

	// Length of the folder path, the separator, the extension, and the reserved suffix space.
	const fixedLen =
		(fixedParts ? fixedParts.length + 1 : 0) +
		extensionWithDot.length +
		suffixReserve;

	return Math.max(0, targetMaxPathLen - fixedLen);
}

/**
 * Truncates a filename stem and appends a short hash of the original stem to maintain uniqueness. Pure function.
 * @param stem The original, potentially oversized filename stem.
 * @param budget The maximum allowed length for the final stem.
 * @param hashLength The length of the hash to append.
 * @returns A new, shortened stem that fits within the budget.
 */
export function truncateWithHash(
	stem: string,
	budget: number,
	hashLength: number,
): string {
	if (stem.length <= budget) {
		return stem;
	}

	const separator = "-";
	// If the budget is too small to even hold a hash, return a timestamp-based fallback.
	if (budget <= hashLength + separator.length) {
		return `note-${Date.now().toString(36)}`;
	}

	// Truncate the head of the string, leaving space for the separator and hash.
	const headLength = Math.max(1, budget - (hashLength + separator.length));
	const head = stem.substring(0, headLength).trim();

	const hash = sha1Hex(stem).slice(0, hashLength);
	return `${head}${separator}${hash}`;
}

export function generateScanCacheKey(key: ScanCacheKey): string {
	return `${key.rootPath}|${key.extensions.join(",")}|${key.recursive ? "R" : "NR"}`;
}

export function parseScanCacheKey(raw: string): ScanCacheKey {
	const [root, exts, rflag] = raw.split("|");
	return {
		rootPath: toVaultPath(root ?? ""),
		extensions: exts ? exts.split(",").filter(Boolean) : [],
		recursive: rflag === "R",
	};
}

/**
 * A pure async function that determines a unique filename stem by repeatedly
 * checking candidates against a provided existence checker.
 *
 * @param desiredStem The initial filename stem to start with.
 * @param existsCheck An async function that takes a candidate path and returns true if it exists.
 * @param options Configuration for the generation and truncation logic.
 * @returns A promise that resolves to an object containing the unique stem and a flag indicating if truncation occurred.
 */
export async function generateUniqueStem(
	desiredStem: string,
	existsCheck: (candidatePath: VaultPath) => Promise<boolean>,
	options: {
		baseDir?: string;
		ext?: string;
		maxAttempts?: number;
		// Options for path length budget calculation
		absVaultBase?: string | null;
		targetMaxPathLen?: number;
		suffixReserve?: number;
	} = {},
): Promise<{ stem: string; wasTruncated: boolean }> {
	const {
		baseDir = "",
		ext = "md",
		maxAttempts = 1000,
		absVaultBase = null,
		targetMaxPathLen = 255,
		suffixReserve = 10,
	} = options;

	const extensionWithDot = `.${ext.replace(/^\./, "")}`;
	const sanitizedStem = toFileSafe(desiredStem, {
		fallback: "Untitled",
	});

	const budget = computeStemBudget(
		absVaultBase,
		baseDir,
		extensionWithDot,
		targetMaxPathLen,
		suffixReserve,
	);

	let wasTruncated = false;
	let baseStem = sanitizedStem;

	if (baseStem.length > budget) {
		baseStem = truncateWithHash(
			baseStem,
			budget,
			FILENAME_TRUNCATION_HASH_LENGTH,
		);
		wasTruncated = true;
	}

	for (let i = 0; i < maxAttempts; i++) {
		const suffix = i === 0 ? "" : ` (${i})`;
		const candidateStem = `${baseStem}${suffix}`;

		const candidatePath = joinVaultPath(
			baseDir,
			`${candidateStem}${extensionWithDot}`,
		);

		if (!(await existsCheck(candidatePath))) {
			return { stem: candidateStem, wasTruncated };
		}
	}
	const fallbackStem = `${baseStem}-${Date.now().toString(36)}`;
	const finalStem = truncateWithHash(
		fallbackStem,
		budget,
		FILENAME_TRUNCATION_HASH_LENGTH,
	);

	return { stem: finalStem, wasTruncated: true };
}

export function joinVaultPath(...segments: string[]): VaultPath {
	const joined = posixPath.join(...segments.map((s) => toVaultPath(s)));
	return toVaultPath(joined);
}

/** Normalize an OS-native system path string to forward slashes and no trailing slash. */
export function normalizeSystemPath(p: string | null | undefined): SystemPath {
	if (!p) return "" as SystemPath;
	const raw = String(p);
	const isUnc = raw.startsWith("\\\\") || raw.startsWith("//");

	// Normalize separators to forward slashes first.
	let s = raw.replace(/\\/g, "/");

	if (isUnc) {
		// Preserve the UNC/network prefix `//` (required on Windows for network shares).
		s = s.replace(/^\/{2,}/, "//");
		const rest = s.slice(2).replace(/\/{2,}/g, "/");
		s = `//${rest}`;
	} else {
		// For non-UNC paths, collapse repeated slashes.
		s = s.replace(/\/{2,}/g, "/");
	}

	if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
	return s as SystemPath;
}

/**
 * Strips a Windows drive (e.g., "E:\\" or "E:/") or leading slash from a device path
 * to make it relative to the mount root.
 */
export function stripRootFromDevicePath(p: string): string {
	// Windows drive like "E:\\" or "E:/"
	const win = p.replace(/^[A-Za-z]:[\\/]+/, "");
	if (win !== p) return win;
	// POSIX root
	return p.replace(/^\/+/, "");
}

export function joinSystemPath(...segments: string[]): SystemPath {
	return path.join(...segments) as SystemPath;
}

export function systemDirname(systemPath: SystemPath | string): SystemPath {
	const normalized =
		typeof systemPath === "string"
			? normalizeSystemPath(systemPath)
			: systemPath;
	return path.dirname(normalized) as SystemPath;
}

export function systemBasename(
	systemPath: SystemPath | string,
	ext?: string,
): string {
	const normalized =
		typeof systemPath === "string"
			? normalizeSystemPath(systemPath)
			: systemPath;
	return path.basename(normalized, ext);
}

export function systemRelative(
	from: SystemPath | string,
	to: SystemPath | string,
): string {
	const normalizedFrom =
		typeof from === "string" ? normalizeSystemPath(from) : from;
	const normalizedTo = typeof to === "string" ? normalizeSystemPath(to) : to;
	return path.relative(normalizedFrom, normalizedTo);
}

export function systemResolve(...pathSegments: string[]): SystemPath {
	return path.resolve(...pathSegments) as SystemPath;
}

// ================================================================
// Legacy Compatibility Export
// ================================================================

/**
 * Singleton-like export for backward compatibility with consumers expecting `Pathing.method()`.
 * This is now a stateless namespace object.
 */
export const Pathing = {
	toFileSafe,
	toMatchKey,
	normalizeWhitespace,
	toVaultPath,
	vaultBasenameOf,
	vaultDirname,
	vaultExtnameOf,
	isAncestor,
	simplifySdrName,
	generateFileName,
	validateFileNameTemplate,
	getFileNameWithoutExt,
	generateUniqueStem,
	computeStemBudget,
	truncateWithHash,
	normalizeSystemPath,
	stripRootFromDevicePath,
	joinVaultPath,
	joinSystemPath,
	systemDirname,
	systemBasename,
	systemRelative,
	systemResolve,
	generateScanCacheKey,
	parseScanCacheKey,
	isVaultPath,
	isSystemPath,
	vaultPathToString,
	systemPathToString,
};
