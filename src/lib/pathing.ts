import { parse, posix as posixPath } from "node:path";
import { normalizePath } from "obsidian";
import { SimpleCache } from "src/lib/cache";
import type { CacheManager } from "src/lib/cache/CacheManager";
import type { IterableCache } from "src/lib/cache/types";
import { formatDateForDailyNote } from "src/lib/formatting/dateUtils";
import {
	normalizeWhitespace,
	stripDiacritics,
} from "src/lib/strings/stringUtils";
import type { DocProps } from "src/types";

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
 * Safely create a VaultPath from a raw string.
 * This is the recommended way to create VaultPath instances.
 */
export function createVaultPath(rawPath: string | null | undefined): VaultPath {
	return toVaultPath(rawPath);
}

/**
 * Safely create a SystemPath from a raw string.
 * This is the recommended way to create SystemPath instances.
 */
export function createSystemPath(
	rawPath: string | null | undefined,
): SystemPath {
	return normalizeSystemPath(rawPath);
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

/** Ergonomic DI context for pathing helpers. */
export type PathingContext = {
	fileSafeCache: IterableCache<string, string>;
	matchKeyCache: IterableCache<string, string>;
};

// Small, module-local default caches. These are the fallbacks when callers don't inject.
// Use SimpleCache (Map-backed, optional LRU via max size if needed).
const defaultFileSafeCache: IterableCache<string, string> = new SimpleCache();
const defaultMatchKeyCache: IterableCache<string, string> = new SimpleCache();

// Avoid caching pathological inputs
const MAX_CACHEABLE_INPUT_LEN = 4096;

// Public test/ops hooks
export function clearSlugCaches(): void {
	defaultFileSafeCache.clear();
	defaultMatchKeyCache.clear();
}

export function getSlugCacheSizes(): { fileSafe: number; matchKey: number } {
	return {
		fileSafe: defaultFileSafeCache.size,
		matchKey: defaultMatchKeyCache.size,
	};
}

/** Normalize whitespace: trim + collapse unicode whitespace to a single space. */
/** Strip combining diacritical marks after NFKD normalize. */
export {
	normalizeWhitespace,
	stripDiacritics,
} from "src/lib/strings/stringUtils";

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

function fileSafeCacheKey(input: string, opts?: FileSafeOptions): string {
	const o = normalizeFileSafeOpts(opts);
	// Include the input and all relevant options to avoid collisions across different strings
	// Keep a stable, compact representation
	return [
		"fs",
		input,
		o.maxLength,
		o.lower ? 1 : 0,
		o.ascii ? 1 : 0,
		o.allowUnicode ? 1 : 0,
		o.fallback,
	].join("|");
}

export function toFileSafe(
	input: string | null | undefined,
	opts?: FileSafeOptions,
	cache?: IterableCache<string, string>,
): string {
	const o = normalizeFileSafeOpts(opts);
	let s = String(input ?? "").trim();
	if (!s) return o.fallback;

	// Build cache key early for fast returns
	let key: string | null = null;
	if (s.length <= MAX_CACHEABLE_INPUT_LEN) {
		key = fileSafeCacheKey(s, o);
		const useCache = cache ?? defaultFileSafeCache;
		const cached = useCache.get(key);
		if (cached !== undefined) return cached;
	}

	s = normalizeWhitespace(s);

	if (o.ascii) {
		s = stripDiacritics(s);
		if (!o.allowUnicode) {
			s = s.replace(/[^\w\s.-]/g, "_");
		}
	}

	// Prefer a single pass that handles both '/' and '\\' plus control chars
	s = removeIllegalFsChars(s);

	// Replace disallowed punctuation with underscores, allowing Unicode letters/numbers
	// and common readable punctuation, including both straight and curly apostrophes.
	s = s.replace(/[^\p{L}\p{N} .,_()'’-]/gu, "_");
	// Collapse multiple underscores that may result from consecutive disallowed chars
	s = s.replace(/_+/g, "_");

	// Collapse whitespace only; preserve hyphens/underscores
	s = s.replace(/\s+/g, " ").trim();

	if (o.lower) s = s.toLowerCase();

	s = avoidReservedNames(s);

	if (o.maxLength > 0 && s.length > o.maxLength) {
		s = s.slice(0, o.maxLength).trim();
	}

	const result = s || o.fallback;

	if (key) (cache ?? defaultFileSafeCache).set(key, result);
	return result;
}

export function toPathSegment(
	input: string | null | undefined,
	opts?: FileSafeOptions,
	cache?: IterableCache<string, string>,
): string {
	// Path segment uses the same rules but we double-ensure it’s not "." or ".."
	const seg = toFileSafe(input, opts, cache);
	return avoidReservedNames(seg) || (opts?.fallback ?? "untitled");
}

function normalizeMatchKeyOpts(opts?: MatchKeyOptions) {
	return {
		lower: opts?.lower ?? true,
		ascii: opts?.ascii ?? true,
		collapse: opts?.collapse ?? true,
	};
}

function matchKeyCacheKey(input: string, opts?: MatchKeyOptions): string {
	const o = normalizeMatchKeyOpts(opts);
	return [
		"mk",
		o.lower ? 1 : 0,
		o.ascii ? 1 : 0,
		o.collapse ? 1 : 0,
		input,
	].join("|");
}

export function toMatchKey(
	input: string | null | undefined,
	opts?: MatchKeyOptions,
	cache?: IterableCache<string, string>,
): string {
	const o = normalizeMatchKeyOpts(opts);
	let s = String(input ?? "").trim();
	if (!s) return "";

	let key: string | null = null;
	if (s.length <= MAX_CACHEABLE_INPUT_LEN) {
		key = matchKeyCacheKey(s, o);
		const useCache = cache ?? defaultMatchKeyCache;
		const cached = useCache.get(key);
		if (cached !== undefined) return cached;
	}

	if (o.collapse) s = normalizeWhitespace(s);
	if (o.ascii) s = stripDiacritics(s);

	// Keep only letters/digits; normalize punctuation to spaces
	s = s.replace(/[^a-zA-Z0-9]+/g, " ");
	if (o.collapse) s = s.replace(/\s+/g, " ").trim();
	if (o.lower) s = s.toLowerCase();

	if (key) (cache ?? defaultMatchKeyCache).set(key, s);
	return s;
}

/** Create LRU-backed caches and return a DI context. */
export function createPathingContext(
	cacheManager: CacheManager,
	sizes?: { fileSafe?: number; matchKey?: number },
): PathingContext {
	return {
		fileSafeCache: cacheManager.createLru(
			"pathing.slug.fileSafe",
			sizes?.fileSafe ?? 500,
		),
		matchKeyCache: cacheManager.createLru(
			"pathing.slug.matchKey",
			sizes?.matchKey ?? 1000,
		),
	};
}

/** Bind helpers to a provided context (or fall back to module defaults). */
export function withPathing(ctx?: Partial<PathingContext>) {
	const fcache = ctx?.fileSafeCache ?? defaultFileSafeCache;
	const mcache = ctx?.matchKeyCache ?? defaultMatchKeyCache;
	return {
		toFileSafe: (input: string | null | undefined, opts?: FileSafeOptions) =>
			toFileSafe(input, opts, fcache),
		toPathSegment: (input: string | null | undefined, opts?: FileSafeOptions) =>
			toPathSegment(input, opts, fcache),
		toMatchKey: (input: string | null | undefined, opts?: MatchKeyOptions) =>
			toMatchKey(input, opts, mcache),
	};
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

	// ── 0. Strip a prepended "(……)" leader
	raw = raw.replace(/^\([^)]*\)\s*/, "").trim();

	const parts = raw
		.split(delimiter)
		.map((p) => p.trim())
		.filter(Boolean);

	// ── 1. Drop REPEATED TOKENS  (case-insensitive)
	const seen = new Set<string>();
	const uniq: string[] = [];
	for (const p of parts) {
		const key = p.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			uniq.push(p);
		}
	}

	// ── 2. Drop REPEATED BLOCKS  (A B C  A B C  →  A B C)
	const tokens = [...uniq];
	let changed = true;

	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

	while (changed) {
		changed = false;

		for (let block = Math.floor(tokens.length / 2); block >= 1; block--) {
			// slide a window over the list; whenever we see  [X…] [X…]  collapse it
			outer: for (let i = 0; i + 2 * block <= tokens.length; i++) {
				for (let j = 0; j < block; j++) {
					if (!same(tokens[i + j], tokens[i + block + j])) {
						continue outer; // not identical → keep looking
					}
				}
				// Found a duplicate block – delete the second copy
				tokens.splice(i + block, block);
				changed = true;
				break;
			}
			if (changed) break; // restart with the (possibly) shorter array
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

/* ------------------------------------------------------------------ */
/*                 Vault/System Path Normalization Helpers            */
/* ------------------------------------------------------------------ */

/** Normalize an OS-native system path string to forward slashes and no trailing slash. */
export function normalizeSystemPath(p: string | null | undefined): SystemPath {
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

/** Extension (including dot) of a vault path's basename, or empty string. */
export function vaultExtnameOf(p: VaultPath | string): string {
	const base = vaultBasenameOf(p as VaultPath);
	const idx = base.lastIndexOf(".");
	return idx >= 0 ? base.slice(idx) : "";
}

/** Parent directory of a vault path ("" for root). */
export function getVaultParent(vaultPath: VaultPath | string): VaultPath {
	const normalized =
		typeof vaultPath === "string" ? toVaultPath(vaultPath) : vaultPath;
	const parent = posixPath.dirname(normalized);
	return (parent === "." ? "" : parent) as VaultPath;
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

// Consolidated API object
export const Pathing = {
	normalizeWhitespace,
	stripDiacritics,
	toFileSafe,
	toPathSegment,
	toMatchKey,
	clearSlugCaches,
	getSlugCacheSizes,
	createPathingContext,
	withPathing,
	simplifySdrName,
	getFileNameWithoutExt,
	stripRootFromDevicePath,
	// Path helpers
	normalizeSystemPath,
	toVaultPath,
	vaultBasenameOf,
	vaultExtnameOf,
	getVaultParent,
	isAncestor,
	// Branded type utilities
	createVaultPath,
	createSystemPath,
	vaultPathToString,
	systemPathToString,
	isVaultPath,
	isSystemPath,
};

// ---------------------- Filename Template Helpers ----------------------
export type FileNameTemplateOptions = {
	useCustomTemplate: boolean;
	template: string;
};

function renderTemplate(
	template: string,
	data: Record<string, string>,
): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => data[key] || "");
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

const FILE_EXTENSION = ".md";

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
		baseName = renderTemplate(options.template, templateData);
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
	return `${sanitized}${FILE_EXTENSION}`;
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

Object.assign(Pathing, { generateFileName, validateFileNameTemplate });
