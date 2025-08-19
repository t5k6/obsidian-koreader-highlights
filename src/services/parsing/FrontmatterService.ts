import { type App, type FrontMatterCache, parseYaml, TFile } from "obsidian";
import { KeyedQueue } from "src/lib/concurrency";
import {
	generateFrontmatter as coreGenerateFrontmatter,
	mergeFrontmatter as coreMergeFrontmatter,
	parseFrontmatter as coreParseFrontmatter,
	reconstructFileContent as coreReconstructFileContent,
	stringifyFrontmatter as coreStringifyFrontmatter,
} from "src/lib/content/contentLogic";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type { AppFailure, AppResult } from "src/lib/errors";
import { FRONTMATTER_REGEX } from "src/lib/frontmatter/frontmatterUtils";
import { normalize as normalizeField } from "src/lib/parsing/fieldMapping";
import { toFileSafe } from "src/lib/pathing";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type {
	BookMetadata,
	FileMetadataExtractor,
	FrontmatterData,
	FrontmatterSettings,
	LuaMetadata,
	ParsedFrontmatter,
} from "src/types";

export class FrontmatterService implements FileMetadataExtractor {
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
	 * Atomically edit a note by reading, applying a pure updater, and writing back.
	 * - Serializes per-path via KeyedQueue
	 * - Preserves YAML formatting by reconstructing with stringify()
	 * - Optional hooks before/after write
	 */
	public async editFile(
		file: TFile,
		updater: NoteUpdater,
		options: EditFileOptions = {},
	): Promise<AppResult<EditFileResult>> {
		return this.editQueue.run(file.path, async () => {
			const initialMtime = file.stat.mtime ?? 0;
			// Read current content
			const readRes = await this.fs.readVaultText(file.path);
			if (isErr(readRes)) {
				this.log.error("editFile: read failed", {
					file: file.path,
					error: readRes.error,
				});
				return err(readRes.error as AppFailure);
			}
			const currentContent = readRes.value;
			const currentDoc = this.parseContent(currentContent);

			// Compute next doc
			const maybeNext = await updater({
				frontmatter: currentDoc.frontmatter ?? {},
				body: currentDoc.body,
			});
			const nextDoc = maybeNext ?? {
				frontmatter: currentDoc.frontmatter ?? {},
				body: currentDoc.body,
			};

			// Detect changes
			const fmEqual = this.areFrontmattersEqual(
				currentDoc.frontmatter ?? {},
				nextDoc.frontmatter ?? {},
			);
			const bodyEqual = (currentDoc.body ?? "") === (nextDoc.body ?? "");
			if (options.skipIfNoChange && fmEqual && bodyEqual) {
				return ok({ changed: false, file });
			}

			const newContent = this.reconstructFileContent(
				nextDoc.frontmatter ?? {},
				nextDoc.body ?? "",
			);

			// Optional pre-write hook
			if (options.beforeWrite) {
				const pre = await options.beforeWrite({
					file,
					newContent,
					currentDoc: {
						frontmatter: currentDoc.frontmatter ?? {},
						body: currentDoc.body,
					},
					nextDoc: {
						frontmatter: nextDoc.frontmatter ?? {},
						body: nextDoc.body ?? "",
					},
				});
				if (isErr(pre as Result<void, AppFailure>)) {
					return pre as unknown as AppResult<EditFileResult>;
				}
			}

			// Concurrent modification detection (simple mtime CAS)
			if (options.detectConcurrentModification) {
				const currentFile = this.app.vault.getAbstractFileByPath(file.path);

				// Use a type guard to ensure we have a TFile before accessing .stat
				if (currentFile instanceof TFile) {
					const currentMtime = currentFile.stat.mtime;
					if (currentMtime > initialMtime) {
						this.log.warn(
							"editFile: concurrent modification detected (mtime changed)",
							{
								file: file.path,
								initialMtime,
								currentMtime,
							},
						);
						return err({
							kind: "WriteFailed",
							path: file.path,
							cause: "ConcurrentModification",
						});
					}
				} else {
					// If the file is now missing or has been replaced by a folder,
					// it's a definite concurrent modification.
					this.log.warn(
						"editFile: concurrent modification detected (file deleted or replaced by folder)",
						{
							file: file.path,
							initialMtime,
						},
					);
					return err({
						kind: "WriteFailed",
						path: file.path,
						cause: "ConcurrentModification",
					});
				}
			}

			// Write
			const writeRes = await this.fs.modifyVaultFileWithRetry(file, newContent);
			if (isErr(writeRes)) {
				this.log.error("editFile: write failed", {
					file: file.path,
					error: writeRes.error,
				});
				return err(writeRes.error as AppFailure);
			}

			// Optional post-write hook (best-effort)
			try {
				await options.afterWrite?.({
					file,
					newContent,
					currentDoc: {
						frontmatter: currentDoc.frontmatter ?? {},
						body: currentDoc.body,
					},
					nextDoc: {
						frontmatter: nextDoc.frontmatter ?? {},
						body: nextDoc.body ?? "",
					},
				});
			} catch (e) {
				this.log.warn("editFile: afterWrite hook threw", e);
			}

			return ok({ changed: true, file });
		});
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
	 * This implementation is unified to a single, robust parsing path to
	 * ensure correctness and simplify maintenance.
	 * @param file The TFile to parse.
	 * @returns A promise resolving to an object with the parsed frontmatter and body.
	 */
	public async parseFile(
		file: TFile,
	): Promise<{ frontmatter: FrontMatterCache; body: string }> {
		// 1. Perform the stateful "shell" operation: Read the file content.
		const readResult = await this.fs.readVaultText(file.path);

		if (isErr(readResult)) {
			this.log.warn(
				`Failed to read file during parseFile: ${file.path}`,
				(readResult as any).error ?? readResult,
			);
			return { frontmatter: {}, body: "" };
		}

		// 2. Pass the raw data to the pure, reliable "core" function.
		return this.parseContent(readResult.value);
	}

	/**
	 * [STATEFUL SHELL] Extracts minimal book metadata for indexing. This method
	 * orchestrates getting the frontmatter (a side-effect) and then calls the
	 * pure, static `extractBookMetadata` function to perform the transformation.
	 */
	public async extractMetadata(file: TFile): Promise<BookMetadata | null> {
		try {
			const fm = await this.getFrontmatterFromFile(file);
			return fm ? FrontmatterService.extractBookMetadata(fm, file.path) : null;
		} catch (e) {
			this.log.warn(`extractMetadata failed for ${file.path}`, e);
			return null;
		}
	}

	/**
	 * [FUNCTIONAL CORE] Pure function to extract book metadata from a frontmatter object.
	 * This method is static, has no side-effects, and does not depend on `this`.
	 * @param fm The frontmatter object.
	 * @param vaultPath The path of the file, used for the returned metadata.
	 * @returns `BookMetadata` or `null` if essential fields are missing.
	 */
	public static extractBookMetadata(
		fm: Record<string, unknown>,
		vaultPath: string,
	): BookMetadata | null {
		// Canonicalize keys first (friendly/case-insensitive -> canonical)
		const canonical: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(fm)) {
			const canon = normalizeField(k);
			canonical[canon] = v;
		}
		const title = String((canonical as any).title ?? "");
		const authors = String(
			(canonical as any).authors ?? (canonical as any).author ?? "",
		);

		if (!title && !authors) return null;

		const authorSlug = toFileSafe(authors, { lower: true, fallback: "" });
		const titleSlug = toFileSafe(title, { lower: true, fallback: "" });
		const key = `${authorSlug}::${titleSlug}`;

		return { title, authors, key, vaultPath };
	}

	/**
	 * [STATEFUL HELPER] Gets frontmatter from a file, prioritizing the metadata cache,
	 * then falling back to a partial file read.
	 */
	private async getFrontmatterFromFile(
		file: TFile,
	): Promise<Record<string, unknown> | null> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache?.frontmatter) {
			return cache.frontmatter;
		}

		const content = await this.readPartial(file, 4096);
		const match = content.match(FRONTMATTER_REGEX);
		if (!match) return null;

		try {
			return (parseYaml(match[1]) as Record<string, unknown>) ?? null;
		} catch (e) {
			this.log.warn(`YAML parse failed for partial read of ${file.path}`, e);
			return null;
		}
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
		return coreParseFrontmatter(content);
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
		return coreStringifyFrontmatter(data, options);
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
		return coreReconstructFileContent(frontmatter, body);
	}

	private areFrontmattersEqual(fm1: any, fm2: any): boolean {
		try {
			const a = coreStringifyFrontmatter(fm1 ?? {}, {
				useFriendlyKeys: true,
				sortKeys: true,
			});
			const b = coreStringifyFrontmatter(fm2 ?? {}, {
				useFriendlyKeys: true,
				sortKeys: true,
			});
			return a === b;
		} catch {
			return false;
		}
	}
}

// ---------------------- Static Frontmatter Generators ----------------------
export class _FrontmatterStaticHelpers {}

export namespace FrontmatterService {
	export function createFrontmatterData(
		meta: LuaMetadata,
		opts: FrontmatterSettings,
		uid?: string,
	): FrontmatterData {
		return coreGenerateFrontmatter(meta, opts, uid);
	}

	export function mergeFrontmatterData(
		existing: ParsedFrontmatter,
		meta: LuaMetadata,
		opts: FrontmatterSettings,
	): FrontmatterData {
		return coreMergeFrontmatter(existing, meta, opts);
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
	beforeWrite?: (ctx: EditContext) => Promise<AppResult<void>>;
	afterWrite?: (ctx: EditContext) => Promise<void>;
};
