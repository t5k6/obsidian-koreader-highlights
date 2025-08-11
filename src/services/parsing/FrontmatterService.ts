import {
	type App,
	type FrontMatterCache,
	parseYaml,
	stringifyYaml,
	type TFile,
} from "obsidian";
import type { LoggingService } from "src/services/LoggingService";
import type { BookMetadata, FileMetadataExtractor } from "src/types";
import {
	formatDateWithFormat,
	secondsToHoursMinutesSeconds,
} from "src/utils/dateUtils";
import { formatPercent, normalizeFileNamePiece } from "src/utils/formatUtils";
import { FieldMappingService } from "./FieldMappingService";

// --- Formatting Constants and Helpers ---
type ProgKey =
	| "title"
	| "authors"
	| "description"
	| "keywords"
	| "series"
	| "language"
	| "pages"
	| "highlightCount"
	| "noteCount"
	| "lastRead"
	| "firstRead"
	| "totalReadTime"
	| "progress"
	| "readingStatus"
	| "averageTimePerPage";

function splitAndTrim(s: string, rx: RegExp): string[] {
	return s
		.split(rx)
		.map((x) => x.trim())
		.filter(Boolean);
}

const metaFieldFormatters: Partial<Record<ProgKey, (v: unknown) => unknown>> = {
	lastRead: (v) => formatDateWithFormat(String(v), "YYYY-MM-DD"),
	firstRead: (v) => formatDateWithFormat(String(v), "YYYY-MM-DD"),
	totalReadTime: (v) => secondsToHoursMinutesSeconds(Number(v)),
	averageTimePerPage: (v) => secondsToHoursMinutesSeconds(Number(v) * 60),
	progress: (v) => formatPercent(Number(v)),
	readingStatus: (v) => String(v ?? ""),
	description: (v) => String(v ?? "").replace(/<[^>]+>/g, ""), // strip html
	authors: (v) => {
		if (Array.isArray(v)) return v;
		if (typeof v === "string" && v.startsWith("[[")) return v;
		const arr = splitAndTrim(String(v), /\s*[,;&\n]\s*/);
		const links = arr.map((a) => {
			// Escape special wikilink characters that would break the link: |, ], #, ^
			const escaped = a.replace(/([|#^\]])/g, "\\$1");
			return `[[${escaped}]]`;
		});
		return links.length === 1 ? links[0] : links;
	},
	keywords: (v) => (Array.isArray(v) ? v : splitAndTrim(String(v), /,/)),
};

export class FrontmatterService implements FileMetadataExtractor {
	private static readonly FRONTMATTER_REGEX =
		/^---\s*?\r?\n([\s\S]+?)\r?\n---\s*?\r?\n?/s;
	private readonly log;

	constructor(
		private readonly app: App,
		private readonly loggingService: LoggingService,
	) {
		this.log = this.loggingService.scoped("FrontmatterService");
	}

	/**
	 * Asynchronously parses a TFile to separate its frontmatter and body.
	 * Uses Obsidian's metadata cache for improved performance and accuracy.
	 * @param file The TFile to parse.
	 * @returns A promise resolving to an object with the parsed frontmatter and body.
	 */
	public async parseFile(
		file: TFile,
	): Promise<{ frontmatter: FrontMatterCache; body: string }> {
		const cache = this.app.metadataCache.getFileCache(file);

		// Fast path via cache
		if (cache?.frontmatterPosition) {
			const content = await this.app.vault.read(file);
			const body = content.slice(cache.frontmatterPosition.end.offset);
			// Avoid a second YAML parse; rely on cache.frontmatter here
			return { frontmatter: cache.frontmatter ?? {}, body: body.trimStart() };
		}

		// Fallback: parse content ourselves
		const content = await this.app.vault.read(file);
		return this.parseContent(content);
	}

	/**
	 * Extract minimal book metadata for indexing. Prioritizes metadata cache,
	 * falls back to a partial file read and YAML parse.
	 */
	public async extractMetadata(file: TFile): Promise<BookMetadata | null> {
		try {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter) {
				return this.extractFromFrontmatter(cache.frontmatter, file.path);
			}

			const content = await this.readPartial(file, 4096);
			const match = content.match(FrontmatterService.FRONTMATTER_REGEX);
			if (!match) return null;

			try {
				const fm = parseYaml(match[1]) ?? {};
				return this.extractFromFrontmatter(
					fm as Record<string, unknown>,
					file.path,
				);
			} catch (e) {
				this.log.warn(`YAML parse failed for partial read of ${file.path}`, e);
				return null;
			}
		} catch (e) {
			this.log.warn(`extractMetadata failed for ${file.path}`, e);
			return null;
		}
	}

	private extractFromFrontmatter(
		fm: Record<string, unknown>,
		vaultPath: string,
	): BookMetadata | null {
		// Canonicalize keys first (friendly/case-insensitive -> canonical)
		const canonical: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(fm)) {
			const canon = FieldMappingService.normalize(k);
			canonical[canon] = v;
		}
		const title = String((canonical as any).title ?? "");
		const authors = String(
			(canonical as any).authors ?? (canonical as any).author ?? "",
		);

		if (!title && !authors) return null;

		const authorSlug = normalizeFileNamePiece(authors).toLowerCase();
		const titleSlug = normalizeFileNamePiece(title).toLowerCase();
		const key = `${authorSlug}::${titleSlug}`;

		return { title, authors, key, vaultPath };
	}

	private async readPartial(file: TFile, bytes: number): Promise<string> {
		// Prefer a true partial read via FileSystemAdapter when available (desktop)
		try {
			const adapter: any = this.app.vault.adapter as any;
			if (
				adapter &&
				typeof adapter.getFullPath === "function" &&
				adapter.fs?.promises?.open
			) {
				const fullPath = adapter.getFullPath(file.path);
				const handle = await adapter.fs.promises.open(fullPath, "r");
				try {
					const buf: Buffer = Buffer.alloc(bytes);
					const { bytesRead } = await handle.read(buf, 0, bytes, 0);
					return buf.subarray(0, bytesRead).toString("utf8");
				} finally {
					await handle.close();
				}
			}
		} catch (_e) {
			// Fall through to full read on any failure
			// Avoid noisy logs; this is a best-effort optimization
		}

		// Fallback: full read then slice (works across platforms/adapters)
		const content = await this.app.vault.read(file);
		return content.slice(0, bytes);
	}

	/**
	 * Parses a raw string to separate its frontmatter and body content.
	 * @param content The full content of a note.
	 * @returns An object containing the parsed frontmatter and the body.
	 */
	public parseContent(content: string): {
		frontmatter: FrontMatterCache;
		body: string;
	} {
		const { yaml, body } = this.splitFrontmatter(content);
		let frontmatter: FrontMatterCache = {};
		if (yaml) {
			try {
				frontmatter = parseYaml(yaml) ?? {};
			} catch (e) {
				this.log.error(
					"FrontmatterService: Failed to parse YAML block:",
					e,
					yaml,
				);
			}
		}
		return { frontmatter, body: body.trimStart() };
	}

	/**
	 * Converts a data object into a YAML frontmatter string with advanced formatting.
	 * @param data The object to stringify.
	 * @param options Formatting options like using friendly keys and sorting.
	 * @returns A formatted YAML string, NOT including the '---' delimiters.
	 */
	public stringify(
		data: Record<string, unknown>,
		options: { useFriendlyKeys?: boolean; sortKeys?: boolean } = {},
	): string {
		if (!data || Object.keys(data).length === 0) {
			return "";
		}

		const { useFriendlyKeys = true, sortKeys = true } = options;
		const output: Record<string, unknown> = {};

		let entries = Object.entries(data);
		if (sortKeys) {
			entries = entries.sort(([a], [b]) => a.localeCompare(b));
		}

		for (const [key, rawValue] of entries) {
			if (rawValue === undefined || rawValue === null) continue;

			// Normalize incoming key if it's a friendly key
			const progKey = (FieldMappingService.normalize(key) ?? key) as ProgKey;

			if (
				useFriendlyKeys &&
				(progKey === "highlightCount" || progKey === "noteCount") &&
				rawValue === 0
			) {
				continue;
			}

			const formatter = metaFieldFormatters[progKey];
			const value = formatter ? formatter(rawValue) : rawValue;

			const keyOut = useFriendlyKeys
				? FieldMappingService.toFriendly(progKey)
				: progKey;

			if (value !== "" && (!Array.isArray(value) || value.length > 0)) {
				output[keyOut] = value;
			}
		}

		return Object.keys(output).length > 0 ? stringifyYaml(output) : "";
	}

	/**
	 * Reconstructs the full file content from a frontmatter object and a body string.
	 * @param frontmatter The frontmatter data object.
	 * @param body The main content/body of the note.
	 * @returns The complete string content for a file.
	 */
	public reconstructFileContent(
		frontmatter: Record<string, unknown>,
		body: string,
	): string {
		const yamlString = this.stringify(frontmatter, {
			useFriendlyKeys: true,
			sortKeys: true,
		});

		if (!yamlString) {
			return body.trim();
		}

		return `---\n${yamlString}---\n\n${body.trim()}`;
	}

	private splitFrontmatter(content: string): {
		yaml: string | null;
		body: string;
	} {
		const match = content.match(FrontmatterService.FRONTMATTER_REGEX);
		if (!match) return { yaml: null, body: content };
		return { yaml: match[1] ?? null, body: content.slice(match[0].length) };
	}
}
