import { LruCache } from "src/lib/cache/LruCache";

export type FileSafeOptions = {
	maxLength?: number; // default 120
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

// Small, dedicated caches
const fileSafeCache = new LruCache<string, string>(500);
const matchKeyCache = new LruCache<string, string>(1000);

// Avoid caching pathological inputs
const MAX_CACHEABLE_INPUT_LEN = 4096;

// Public test/ops hooks
export function clearSlugCaches(): void {
	(fileSafeCache as any).clear?.();
	(matchKeyCache as any).clear?.();
}

export function getSlugCacheSizes(): { fileSafe: number; matchKey: number } {
	return {
		fileSafe: (fileSafeCache as any).size ?? 0,
		matchKey: (matchKeyCache as any).size ?? 0,
	};
}

/** Normalize whitespace: trim + collapse unicode whitespace to a single space. */
export function normalizeWhitespace(s: string): string {
	return String(s).trim().replace(/\s+/g, " ");
}

/** Strip combining diacritical marks after NFKD normalize. */
export function stripDiacritics(s: string): string {
	return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
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

function normalizeFileSafeOpts(opts?: FileSafeOptions) {
	return {
		maxLength: opts?.maxLength ?? 120,
		lower: opts?.lower ?? false,
		ascii: opts?.ascii ?? false,
		allowUnicode: opts?.allowUnicode ?? true,
		fallback: opts?.fallback ?? "untitled",
	};
}

function fileSafeCacheKey(input: string, opts?: FileSafeOptions): string {
	const o = normalizeFileSafeOpts(opts);
	// Fixed order key to avoid stringify drift
	return [
		"fs",
		o.lower ? 1 : 0,
		o.ascii ? 1 : 0,
		o.allowUnicode ? 1 : 0,
		o.maxLength,
		o.fallback,
		input,
	].join("|");
}

export function toFileSafe(
	input: string | null | undefined,
	opts?: FileSafeOptions,
): string {
	const o = normalizeFileSafeOpts(opts);
	let s = String(input ?? "").trim();
	if (!s) return o.fallback;

	// Build cache key early for fast returns
	let key: string | null = null;
	if (s.length <= MAX_CACHEABLE_INPUT_LEN) {
		key = fileSafeCacheKey(s, o);
		const cached = fileSafeCache.get(key);
		if (cached !== undefined) return cached;
	}

	s = normalizeWhitespace(s);

	if (o.ascii) {
		s = stripDiacritics(s);
		if (!o.allowUnicode) {
			s = s.replace(/[^\w\s.-]/g, "_");
		}
	}

	// Disallow path separators and illegal filesystem chars
	s = s.replace(/[/]/g, "-");
	s = removeIllegalFsChars(s);

	// Replace disallowed punctuation with underscores; allow common readable punctuation
	s = s.replace(/[^a-zA-Z0-9 .,_()-]/g, "_");
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

	if (key) fileSafeCache.set(key, result);
	return result;
}

export function toPathSegment(
	input: string | null | undefined,
	opts?: FileSafeOptions,
): string {
	// Path segment uses the same rules but we double-ensure it’s not "." or ".."
	const seg = toFileSafe(input, opts);
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
): string {
	const o = normalizeMatchKeyOpts(opts);
	let s = String(input ?? "").trim();
	if (!s) return "";

	let key: string | null = null;
	if (s.length <= MAX_CACHEABLE_INPUT_LEN) {
		key = matchKeyCacheKey(s, o);
		const cached = matchKeyCache.get(key);
		if (cached !== undefined) return cached;
	}

	if (o.collapse) s = normalizeWhitespace(s);
	if (o.ascii) s = stripDiacritics(s);

	// Keep only letters/digits; normalize punctuation to spaces
	s = s.replace(/[^a-zA-Z0-9]+/g, " ");
	if (o.collapse) s = s.replace(/\s+/g, " ").trim();
	if (o.lower) s = s.toLowerCase();

	if (key) matchKeyCache.set(key, s);
	return s;
}

export const Slug = {
	normalizeWhitespace,
	stripDiacritics,
	toFileSafe,
	toPathSegment,
	toMatchKey,
	clearSlugCaches,
	getSlugCacheSizes,
};
