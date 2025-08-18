import {
	type App,
	type FrontMatterCache,
	parseYaml,
	stringifyYaml,
	type TFile,
} from "obsidian";
import { KeyedQueue } from "src/lib/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type { AppFailure } from "src/lib/errors/resultTypes";
import { groupSuccessiveHighlights } from "src/lib/formatting/annotationGrouper";
import {
	formatDateWithFormat,
	secondsToHoursMinutesSeconds,
} from "src/lib/formatting/dateUtils";
import {
	compareAnnotations,
	formatPercent,
} from "src/lib/formatting/formatUtils";
import { createKohlMarkers } from "src/lib/parsing/highlightExtractor";
import { normalizeFileNamePiece } from "src/lib/pathing/pathingUtils";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type {
	CompiledTemplate,
	TemplateManager,
} from "src/services/parsing/TemplateManager";
import type {
	Annotation,
	BookMetadata,
	CommentStyle,
	FileMetadataExtractor,
} from "src/types";
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

function isHms(s: unknown): boolean {
	return typeof s === "string" && /^\s*\d+h \d+m \d+s\s*$/.test(s);
}
function isPercent(s: unknown): boolean {
	return typeof s === "string" && /^\s*\d+(\.\d+)?%\s*$/.test(s);
}

const metaFieldFormatters: Partial<Record<ProgKey, (v: unknown) => unknown>> = {
	lastRead: (v) => formatDateWithFormat(String(v), "YYYY-MM-DD"),
	firstRead: (v) => formatDateWithFormat(String(v), "YYYY-MM-DD"),
	totalReadTime: (v) => {
		if (isHms(v)) return v; // Already formatted, return as-is
		const n = Number(v);
		return Number.isFinite(n)
			? secondsToHoursMinutesSeconds(n)
			: String(v ?? "");
	},
	averageTimePerPage: (v) => {
		if (isHms(v)) return v; // Already formatted, return as-is
		const n = Number(v);
		return Number.isFinite(n)
			? secondsToHoursMinutesSeconds(n)
			: String(v ?? "");
	},
	progress: (v) => {
		if (isPercent(v)) return v; // Already formatted, return as-is
		const n = Number(v);
		return Number.isFinite(n) ? formatPercent(n) : String(v ?? "");
	},
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
	private readonly editQueue = new KeyedQueue();

	constructor(
		private readonly app: App,
		private readonly loggingService: LoggingService,
		private readonly fs: FileSystemService,
	) {
		this.log = this.loggingService.scoped("FrontmatterService");
	}

	/**
	 * Fast, in-place frontmatter edit using Obsidian's API.
	 * Preserves user formatting and key order in YAML.
	 * Use for small, targeted updates (e.g., setting a UID).
	 */
	public async editFrontmatter(
		file: TFile,
		updater: (fm: Record<string, any>) => void,
	): Promise<void> {
		try {
			// This is the only place we should call this Obsidian API directly.
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				updater(fm as unknown as Record<string, any>);
			});
		} catch (e) {
			this.log.error("editFrontmatter failed", { file: file.path, error: e });
			// Re-throw to allow callers to handle the failure.
			throw e;
		}
	}

	/**
	 * Overwrite the entire file with the provided content using Obsidian's vault API.
	 * This updates the metadata cache and emits file change events.
	 */
	public async overwriteFile(file: TFile, content: string): Promise<void> {
		try {
			const res = await this.fs.modifyVaultFileWithRetry(file, content);
			if (isErr(res)) {
				this.log.error("overwriteFile failed", {
					file: file.path,
					error: res.error,
				});
				throw (
					(res as any).error ?? new Error("modifyVaultFileWithRetry failed")
				);
			}
		} catch (e) {
			this.log.error("overwriteFile failed", { file: file.path, error: e });
			throw e;
		}
	}

	/**
	 * Convenience method to apply a partial patch to a note's frontmatter.
	 * Setting a key's value to `undefined` will remove it.
	 */
	public async setFrontmatterFields(
		file: TFile,
		patch: Record<string, unknown>,
	): Promise<void> {
		return this.editFrontmatter(file, (fm) => {
			for (const [k, v] of Object.entries(patch)) {
				if (v === undefined) {
					delete (fm as any)[k];
				} else {
					(fm as any)[k] = v;
				}
			}
		});
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
			const r = await this.fs.readVaultText(file.path);
			if (isErr(r)) {
				this.log.warn(
					`Failed to read file for cached frontmatter fast-path: ${file.path}`,
					(r as any).error ?? r,
				);
				// Fall back to empty body but preserve cached frontmatter
				return { frontmatter: cache.frontmatter ?? {}, body: "" };
			}
			const body = r.value.slice(cache.frontmatterPosition.end.offset);
			// Avoid a second YAML parse; rely on cache.frontmatter here
			return { frontmatter: cache.frontmatter ?? {}, body: body.trimStart() };
		}

		// Fallback: parse content ourselves
		const r2 = await this.fs.readVaultText(file.path);
		if (isErr(r2)) {
			this.log.warn(
				`Failed to read file during parseFile: ${file.path}`,
				(r2 as any).error ?? r2,
			);
			return { frontmatter: {}, body: "" };
		}
		return this.parseContent(r2.value);
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
		// Simpler and adapter-agnostic: full read via FileSystemService, then slice
		const r = await this.fs.readVaultText(file.path);
		if (isErr(r)) {
			this.log.warn(
				`readPartial failed for ${file.path}`,
				(r as any).error ?? r,
			);
			return "";
		}
		return r.value.slice(0, bytes);
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

	/**
	 * Pure function to compose body content from annotations using a pre-compiled template.
	 * Callers are responsible for loading/compiling the template and providing settings.
	 */
	public composeBody(
		annotations: Annotation[],
		compiledTemplate: CompiledTemplate,
		templateManager: TemplateManager,
		commentStyle: CommentStyle,
		maxHighlightGap: number,
	): string {
		const anns = annotations ?? [];
		if (anns.length === 0) return "";

		// 1) Group by chapter without mutating input
		const grouped = new Map<string, Annotation[]>();
		for (const ann of anns) {
			const chapter = ann.chapter?.trim() || "Chapter Unknown";
			const arr = grouped.get(chapter);
			if (arr) arr.push(ann);
			else grouped.set(chapter, [ann]);
		}

		// 2) Sort annotations within each chapter and compute chapter start page
		const chapters = Array.from(grouped.entries()).map(
			([chapterName, chapterAnnotations]) => {
				const sorted = [...chapterAnnotations].sort(compareAnnotations);
				// Clone to avoid mutating input while ensuring templates get chapter on each annotation
				const withChapter = sorted.map((a) => ({ ...a, chapter: chapterName }));
				const startPage = withChapter[0]?.pageno ?? 0;
				return { name: chapterName, startPage, annotations: withChapter };
			},
		);

		// 3) Sort chapters by start page
		chapters.sort((a, b) => a.startPage - b.startPage);

		// 4) Render each chapter
		const renderedBlocks: string[] = [];
		for (const chapter of chapters) {
			if (!chapter.annotations || chapter.annotations.length === 0) continue;
			const groups = groupSuccessiveHighlights(
				chapter.annotations,
				maxHighlightGap,
			);
			let isFirstInChapter = true;

			for (const g of groups) {
				const rendered = templateManager.renderGroup(
					compiledTemplate,
					g.annotations,
					{
						separators: g.separators,
						isFirstInChapter,
					},
				);

				// Add KOHL markers unless comment style is "none"
				const block =
					commentStyle !== "none"
						? `${createKohlMarkers(g.annotations, commentStyle)}\n${rendered}`
						: rendered;

				renderedBlocks.push(block);
				isFirstInChapter = false;
			}
		}

		return renderedBlocks.join("\n\n");
	}

	/**
	 * Provides a safe, serialized, and transactional Read-Modify-Write workflow for vault files.
	 * This is the canonical method for performing content-aware file modifications.
	 */
	public async editFile(
		file: TFile,
		updater: NoteUpdater,
		opts: EditFileOptions = {},
	): Promise<Result<EditFileResult, AppFailure>> {
		return this.editQueue.run(`edit:${file.path}`, async () => {
			const initialMtime = opts.detectConcurrentModification
				? file.stat.mtime
				: null;

			const parsed = await this.parseFile(file);
			const currentDoc: NoteDoc = {
				frontmatter: (parsed.frontmatter as Record<string, unknown>) ?? {},
				body: parsed.body,
			};

			const nextDoc = await updater(currentDoc);
			if (nextDoc === null || nextDoc === undefined) {
				return ok({ changed: false, file });
			}

			const newContent = this.reconstructFileContent(
				nextDoc.frontmatter ?? {},
				nextDoc.body ?? "",
			);
			if (opts.skipIfNoChange) {
				if (
					currentDoc.body === (nextDoc.body ?? "") &&
					this.areFrontmattersEqual(currentDoc.frontmatter, nextDoc.frontmatter)
				) {
					return ok({ changed: false, file });
				}
			}

			if (initialMtime !== null && file.stat.mtime !== initialMtime) {
				return err({
					kind: "WriteFailed",
					path: file.path,
					cause: new Error(
						"Concurrent modification detected: File was modified by another process during the operation.",
					),
				});
			}

			const ctx: EditContext = { file, newContent, currentDoc, nextDoc };

			if (opts.beforeWrite) {
				const hookResult = await opts.beforeWrite(ctx);
				if (isErr(hookResult)) return hookResult;
			}

			const writeResult = await this.fs.writeVaultFile(file.path, newContent);
			if (isErr(writeResult)) return writeResult;
			const writtenFile = writeResult.value;

			if (opts.afterWrite) {
				try {
					await opts.afterWrite({ ...ctx, file: writtenFile });
				} catch (e) {
					this.log.warn(
						`Best-effort afterWrite hook failed for ${file.path}`,
						e,
					);
				}
			}

			return ok({ changed: true, file: writtenFile });
		});
	}

	private areFrontmattersEqual(fm1: any, fm2: any): boolean {
		try {
			return JSON.stringify(fm1 ?? {}) === JSON.stringify(fm2 ?? {});
		} catch {
			return false;
		}
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

// ---------------------- Types for editFile API ----------------------
export type NoteDoc = {
	frontmatter: Record<string, unknown>;
	body: string;
};

export type NoteUpdater = (
	doc: NoteDoc,
) => NoteDoc | null | undefined | Promise<NoteDoc | null | undefined>;

export type EditContext = {
	file: TFile;
	newContent: string;
	currentDoc: NoteDoc;
	nextDoc: NoteDoc;
};

export type EditFileResult = {
	changed: boolean;
	file: TFile;
};

export type EditFileOptions = {
	skipIfNoChange?: boolean;
	detectConcurrentModification?: boolean;
	beforeWrite?: (ctx: EditContext) => Promise<Result<void, AppFailure>>;
	afterWrite?: (ctx: EditContext) => Promise<void>;
};
