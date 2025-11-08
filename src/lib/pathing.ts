import path, { parse, posix as posixPath } from "node:path";
import { normalizePath } from "obsidian";
import { FILENAME_TRUNCATION_HASH_LENGTH } from "src/constants";
import { SimpleCache } from "src/lib/cache";
import type { IterableCache } from "src/lib/cache/types";
import { formatDateForDailyNote } from "src/lib/formatting/dateUtils";
import {
	normalizeWhitespace,
	stripDiacritics,
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
function isVaultPath(path: string): path is VaultPath {
	return true; // Runtime check not feasible for branded types
}

/**
 * Type guard to check if a string is already a SystemPath.
 * Note: This is a runtime no-op but helps with type checking.
 */
function isSystemPath(path: string): path is SystemPath {
	return true; // Runtime check not feasible for branded types
}

/**
 * Convert a VaultPath to a string for compatibility with APIs that expect raw strings.
 * Use sparingly - prefer keeping the branded type when possible.
 */
function vaultPathToString(path: VaultPath): string {
	return path as string;
}

/**
 * Convert a SystemPath to a string for compatibility with APIs that expect raw strings.
 * Use sparingly - prefer keeping the branded type when possible.
 */
function systemPathToString(path: SystemPath): string {
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

// Avoid caching pathological inputs
const MAX_CACHEABLE_INPUT_LEN = 4096;

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
		ascii: opts?.ascii ?? true,
		collapse: opts?.collapse ?? true,
	};
}

function computeToFileSafe(
	input: string | null | undefined,
	opts?: FileSafeOptions,
): string {
	const o = normalizeFileSafeOpts(opts);
	let s = String(input ?? "").trim();
	if (!s) return o.fallback;

	s = normalizeWhitespace(s);
	if (o.ascii) {
		s = stripDiacritics(s);
		if (!o.allowUnicode) {
			s = s.replace(/[^\w\s.-]/g, "_");
		}
	}
	s = removeIllegalFsChars(s);
	s = s.replace(/[^\p{L}\p{N} .,_()'’-]/gu, "_").replace(/_+/g, "_");
	s = s.replace(/\s+/g, " ").trim();
	if (o.lower) s = s.toLowerCase();
	s = avoidReservedNames(s);
	if (o.maxLength > 0 && s.length > o.maxLength) {
		s = s.slice(0, o.maxLength).trim();
	}
	return s || o.fallback;
}

function computeMatchKey(
	input: string | null | undefined,
	opts?: MatchKeyOptions,
): string {
	const o = normalizeMatchKeyOpts(opts);
	let s = String(input ?? "").trim();
	if (!s) return "";

	if (o.collapse) s = normalizeWhitespace(s);
	if (o.ascii) s = stripDiacritics(s);
	s = s.replace(/[^a-zA-Z0-9]+/g, " ");
	if (o.collapse) s = s.replace(/\s+/g, " ").trim();
	if (o.lower) s = s.toLowerCase();
	return s || "untitled";
}

/**
 * Simplifies KOReader SDR directory names to human-readable format.
 * Removes series prefixes, duplicate tokens, and duplicate blocks.
 * Case-insensitive but preserves first spelling encountered.
 */
function simplifySdrName(raw: string, delimiter = " - "): string {
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
function getFileNameWithoutExt(filePath: string | undefined): string {
	if (!filePath) return "";
	return parse(filePath).name;
}

const FILE_EXTENSION = ".md";

/** Generates a sanitized .md filename based on template or defaults. */
function generateFileName(
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
		baseName = renderTemplate(options.template, templateData);
	} else {
		baseName = generateDefaultBaseName(docProps, originalSdrName);
	}

	if (!baseName?.trim()) {
		baseName =
			simplifySdrName(getFileNameWithoutExt(originalSdrName)) || "Untitled";
	}

	const sanitized = PathingClass.INSTANCE.toFileSafe(baseName, {
		fallback: "Untitled",
		maxLength: 0,
	});
	return `${sanitized}${FILE_EXTENSION}`;
}

/** Validates a filename template string for allowed placeholders. */
function validateFileNameTemplate(template: string): {
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

function renderTemplate(
	template: string,
	data: Record<string, string>,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] || "");
}

function computeStemBudget(
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
function truncateWithHash(
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

function generateScanCacheKey(key: ScanCacheKey): string {
	return `${key.rootPath}|${key.extensions.join(",")}|${key.recursive ? "R" : "NR"}`;
}

function parseScanCacheKey(raw: string): ScanCacheKey {
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
async function generateUniqueStem(
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
	// 1. Normalize options and sanitize the initial stem.
	const {
		baseDir = "",
		ext = "md",
		maxAttempts = 1000,
		absVaultBase = null,
		targetMaxPathLen = 255,
		suffixReserve = 10, // Reserve space for " (999).md"
	} = options;

	const extensionWithDot = `.${ext.replace(/^\./, "")}`;
	const sanitizedStem = PathingClass.INSTANCE.toFileSafe(desiredStem, {
		fallback: "Untitled",
	});

	// 2. Calculate the maximum allowed length for the stem. This budget already
	//    accounts for the suffix, ensuring our base stem has enough room.
	const budget = computeStemBudget(
		absVaultBase,
		baseDir,
		extensionWithDot,
		targetMaxPathLen,
		suffixReserve,
	);

	// 3. Calculate the stable, truncated base stem ONCE.
	//    This `baseStem` will now be immutable throughout the uniqueness check.
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

	// 4. Iterate to find a unique stem by appending suffixes to the STABLE base stem.
	for (let i = 0; i < maxAttempts; i++) {
		const suffix = i === 0 ? "" : ` (${i})`;
		const candidateStem = `${baseStem}${suffix}`;

		const candidatePath = joinVaultPath(
			baseDir,
			`${candidateStem}${extensionWithDot}`,
		);

		if (!(await existsCheck(candidatePath))) {
			// Found a unique, valid-length stem.
			return { stem: candidateStem, wasTruncated };
		}
	}

	// 5. If all attempts fail, generate a final fallback with a timestamp.
	const fallbackStem = `${baseStem}-${Date.now().toString(36)}`;
	const finalStem = truncateWithHash(
		fallbackStem,
		budget,
		FILENAME_TRUNCATION_HASH_LENGTH,
	);

	return { stem: finalStem, wasTruncated: true };
}

// Internal helper to join path segments into a single VaultPath.
function joinVaultPath(...segments: string[]): VaultPath {
	const joined = posixPath.join(...segments.map((s) => toVaultPath(s)));
	return toVaultPath(joined);
}

/** Normalize an OS-native system path string to forward slashes and no trailing slash. */
function normalizeSystemPath(p: string | null | undefined): SystemPath {
	if (!p) return "" as SystemPath;
	let s = String(p)
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/");
	if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
	return s as SystemPath;
}

/**
 * Converts a path to a canonical, vault-relative format.
 * Single source of truth for vault path normalization.
 */
function toVaultPath(rawPath: string | null | undefined): VaultPath {
	if (!rawPath) return "" as VaultPath;
	const p = normalizePath(String(rawPath).trim());
	if (p === "/" || p === "." || p === "") return "" as VaultPath;
	return p.replace(/^\/+/, "").replace(/\/+$/, "") as VaultPath;
}

/** Basename (final segment) of a vault path string. */
function vaultBasenameOf(p: VaultPath | string): string {
	const norm = typeof p === "string" ? toVaultPath(p) : p;
	const parts = norm.split("/");
	return parts[parts.length - 1] ?? "";
}

/** Extension (including dot) of a vault path's basename, or empty string. */
function vaultExtnameOf(p: VaultPath | string): string {
	const base = vaultBasenameOf(p as VaultPath);
	const idx = base.lastIndexOf(".");
	return idx >= 0 ? base.slice(idx) : "";
}

/** Returns true if ancestor is the same as or a parent of child (vault path semantics). */
function isAncestor(
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
 * Strips a Windows drive (e.g., "E:\\" or "E:/") or leading slash from a device path
 * to make it relative to the mount root.
 */
function stripRootFromDevicePath(p: string): string {
	// Windows drive like "E:\\" or "E:/"
	const win = p.replace(/^[A-Za-z]:[\\/]+/, "");
	if (win !== p) return win;
	// POSIX root
	return p.replace(/^\/+/, "");
}

// =====================================================================================
// PATHING CLASS - The new singleton-based API
// =====================================================================================

export class PathingClass {
	public static readonly INSTANCE: PathingClass = new PathingClass();

	readonly #fileSafeCache: IterableCache<string, string>;
	readonly #matchKeyCache: IterableCache<string, string>;

	/**
	 * Private constructor - use Pathing.INSTANCE or new Pathing() for testing.
	 * Creates default caches if none provided.
	 */
	private constructor(
		fileSafeCache?: IterableCache<string, string>,
		matchKeyCache?: IterableCache<string, string>,
	) {
		this.#fileSafeCache = fileSafeCache ?? new SimpleCache<string, string>();
		this.#matchKeyCache = matchKeyCache ?? new SimpleCache<string, string>();
	}

	// Public test/ops hooks
	clearSlugCaches(): void {
		this.#fileSafeCache.clear();
		this.#matchKeyCache.clear();
	}

	getSlugCacheSizes(): { fileSafe: number; matchKey: number } {
		return {
			fileSafe: this.#fileSafeCache.size,
			matchKey: this.#matchKeyCache.size,
		};
	}

	toFileSafe(input: string | null | undefined, opts?: FileSafeOptions): string {
		const o = normalizeFileSafeOpts(opts);
		const s = String(input ?? "");

		// Caching logic
		let key: string | null = null;
		if (s.length <= MAX_CACHEABLE_INPUT_LEN) {
			key = `fs|${s}|${o.maxLength}|${o.lower ? 1 : 0}|${o.ascii ? 1 : 0}|${o.allowUnicode ? 1 : 0}|${o.fallback}`;
			const cached = this.#fileSafeCache.get(key);
			if (cached !== undefined) return cached;
		}

		// Pure computation
		const result = computeToFileSafe(input, opts);

		// Cache the result
		if (key) this.#fileSafeCache.set(key, result);
		return result;
	}

	toMatchKey(input: string | null | undefined, opts?: MatchKeyOptions): string {
		const o = normalizeMatchKeyOpts(opts);
		const s = String(input ?? "");

		// Caching logic
		let key: string | null = null;
		if (s.length <= MAX_CACHEABLE_INPUT_LEN) {
			key = `mk|${s}|${o.lower ? 1 : 0}|${o.ascii ? 1 : 0}|${o.collapse ? 1 : 0}`;
			const cached = this.#matchKeyCache.get(key);
			if (cached !== undefined) return cached;
		}

		// Pure computation
		const result = computeMatchKey(input, opts);

		// Cache the result
		if (key) this.#matchKeyCache.set(key, result);
		return result;
	}

	normalizeWhitespace(s: string): string {
		return normalizeWhitespace(s);
	}

	toVaultPath(rawPath: string | null | undefined): VaultPath {
		return toVaultPath(rawPath);
	}

	vaultBasenameOf(p: VaultPath | string): string {
		return vaultBasenameOf(p);
	}

	vaultDirname(vaultPath: VaultPath | string): VaultPath {
		const normalized =
			typeof vaultPath === "string" ? toVaultPath(vaultPath) : vaultPath;
		const parent = posixPath.dirname(normalized);
		return (parent === "." ? "" : parent) as VaultPath;
	}

	vaultExtnameOf(p: VaultPath | string): string {
		return vaultExtnameOf(p);
	}

	isAncestor(ancestor: VaultPath | string, child: VaultPath | string): boolean {
		return isAncestor(ancestor, child);
	}

	simplifySdrName(raw: string, delimiter = " - "): string {
		return simplifySdrName(raw, delimiter);
	}

	generateFileName(
		options: FileNameTemplateOptions,
		docProps: DocProps,
		originalSdrName?: string,
	): string {
		return generateFileName(options, docProps, originalSdrName);
	}

	validateFileNameTemplate(template: string): {
		isValid: boolean;
		errors: string[];
		warnings: string[];
	} {
		return validateFileNameTemplate(template);
	}

	getFileNameWithoutExt(filePath: string | undefined): string {
		return getFileNameWithoutExt(filePath);
	}

	generateUniqueStem(
		desiredStem: string,
		existsCheck: (candidatePath: VaultPath) => Promise<boolean>,
		options: {
			baseDir?: string;
			ext?: string;
			maxAttempts?: number;
			absVaultBase?: string | null;
			targetMaxPathLen?: number;
			suffixReserve?: number;
		} = {},
	): Promise<{ stem: string; wasTruncated: boolean }> {
		return generateUniqueStem(desiredStem, existsCheck, options);
	}

	computeStemBudget(
		absVaultBase: string | null,
		vaultFolder: string,
		extensionWithDot: string,
		targetMaxPathLen: number,
		suffixReserve: number,
	): number {
		return computeStemBudget(
			absVaultBase,
			vaultFolder,
			extensionWithDot,
			targetMaxPathLen,
			suffixReserve,
		);
	}

	truncateWithHash(stem: string, budget: number, hashLength: number): string {
		return truncateWithHash(stem, budget, hashLength);
	}

	normalizeSystemPath(p: string | null | undefined): SystemPath {
		return normalizeSystemPath(p);
	}

	stripRootFromDevicePath(p: string): string {
		return stripRootFromDevicePath(p);
	}

	joinVaultPath(...segments: string[]): VaultPath {
		return joinVaultPath(...segments);
	}

	joinSystemPath(...segments: string[]): SystemPath {
		return path.join(...segments) as SystemPath;
	}

	systemDirname(systemPath: SystemPath | string): SystemPath {
		const normalized =
			typeof systemPath === "string"
				? normalizeSystemPath(systemPath)
				: systemPath;
		return path.dirname(normalized) as SystemPath;
	}

	systemBasename(systemPath: SystemPath | string, ext?: string): string {
		const normalized =
			typeof systemPath === "string"
				? normalizeSystemPath(systemPath)
				: systemPath;
		return path.basename(normalized, ext);
	}

	systemRelative(from: SystemPath | string, to: SystemPath | string): string {
		const normalizedFrom =
			typeof from === "string" ? normalizeSystemPath(from) : from;
		const normalizedTo = typeof to === "string" ? normalizeSystemPath(to) : to;
		return path.relative(normalizedFrom, normalizedTo);
	}

	systemResolve(...pathSegments: string[]): SystemPath {
		return path.resolve(...pathSegments) as SystemPath;
	}

	generateScanCacheKey(key: ScanCacheKey): string {
		return generateScanCacheKey(key);
	}

	parseScanCacheKey(raw: string): ScanCacheKey {
		return parseScanCacheKey(raw);
	}

	isVaultPath(path: string): path is VaultPath {
		return isVaultPath(path);
	}

	isSystemPath(path: string): path is SystemPath {
		return isSystemPath(path);
	}

	vaultPathToString(path: VaultPath): string {
		return vaultPathToString(path);
	}

	systemPathToString(path: SystemPath): string {
		return systemPathToString(path);
	}
}

// Export the singleton instance as the main API
export const Pathing = PathingClass.INSTANCE;
