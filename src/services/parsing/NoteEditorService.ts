import type { App, TFile } from "obsidian";
import { isAbortError, KeyedQueue, throwIfAborted } from "src/lib/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import type { AppFailure, AppResult, ParseFailure } from "src/lib/errors/types";
import * as noteCore from "src/lib/noteCore";
import { isTFile } from "src/lib/obsidian/typeguards";
import type { FileSystemService } from "src/services/FileSystemService";
import type { LoggingService } from "src/services/LoggingService";
import type {
	BookMetadata,
	EditFileOptions,
	EditFileResult,
	FileMetadataExtractor,
	NoteUpdater,
} from "src/types";

export class NoteEditorService implements FileMetadataExtractor {
	private readonly log;
	private readonly editQueue = new KeyedQueue();

	constructor(
		private readonly app: App,
		private readonly loggingService: LoggingService,
		private readonly fs: FileSystemService,
	) {
		this.log = this.loggingService.scoped("NoteEditorService");
	}

	/**
	 * Atomically edit a note by reading, applying a pure updater, and writing back.
	 */
	public async editFile(
		file: TFile,
		updater: NoteUpdater,
		options: EditFileOptions = {},
	): Promise<AppResult<EditFileResult>> {
		return this.editQueue.run(file.path, async () => {
			throwIfAborted(options.signal);
			const initialMtime = file.stat.mtime ?? 0;

			// Use the service's own parseFile method, which handles I/O and cancellation
			const parseResult = await this.parseFile(file, options.signal);
			if (isErr(parseResult)) {
				this.log.error(
					"editFile: failed to parse current content, aborting edit.",
					{ file: file.path, error: parseResult.error },
				);
				return err({
					kind: "ReadFailed",
					path: file.path,
					cause: parseResult.error,
				});
			}
			const currentDoc = {
				frontmatter: parseResult.value.frontmatter,
				body: parseResult.value.body,
			};

			const maybeNext = await updater(currentDoc);
			const nextDoc = maybeNext ?? {
				frontmatter: currentDoc.frontmatter,
				body: currentDoc.body,
			};

			const fmEqual = noteCore.areFrontmattersEqual(
				currentDoc.frontmatter,
				nextDoc.frontmatter,
			);
			const bodyEqual = currentDoc.body === nextDoc.body;
			if (options.skipIfNoChange && fmEqual && bodyEqual) {
				return ok({ changed: false, file });
			}

			const newContent = noteCore.reconstructNoteContent(
				nextDoc.frontmatter,
				nextDoc.body,
			);

			if (options.beforeWrite) {
				const pre = await options.beforeWrite({
					file,
					newContent,
					currentDoc,
					nextDoc,
				});
				if (isErr(pre as Result<void, AppFailure>)) {
					return pre as unknown as AppResult<EditFileResult>;
				}
			}

			throwIfAborted(options.signal);
			if (options.detectConcurrentModification) {
				const currentFile = this.app.vault.getAbstractFileByPath(file.path);
				if (isTFile(currentFile)) {
					if (currentFile.stat.mtime > initialMtime) {
						this.log.warn("editFile: concurrent modification detected", {
							file: file.path,
						});
						return err({
							kind: "WriteFailed",
							path: file.path,
							cause: "ConcurrentModification",
						});
					}
				} else {
					return err({
						kind: "WriteFailed",
						path: file.path,
						cause: "ConcurrentModification",
					});
				}
			}

			const writeRes = await this.fs.modifyVaultFileWithRetry(file, newContent);
			if (isErr(writeRes)) {
				this.log.error("editFile: write failed", {
					file: file.path,
					error: writeRes.error,
				});
				return err(writeRes.error as AppFailure);
			}

			try {
				await options.afterWrite?.({ file, newContent, currentDoc, nextDoc });
			} catch (e) {
				this.log.warn("editFile: afterWrite hook threw", e);
			}

			return ok({ changed: true, file });
		});
	}

	/**
	 * Fast, in-place frontmatter edit using Obsidian's API.
	 */
	public async editFrontmatter(
		file: TFile,
		updater: (fm: Record<string, any>) => void,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				updater(fm as unknown as Record<string, any>);
			});
		} catch (e) {
			this.log.error("editFrontmatter failed", { file: file.path, error: e });
			throw e;
		}
	}

	/**
	 * [STATEFUL SHELL] Asynchronously parses a TFile into a structured result.
	 */
	public async parseFile(
		file: TFile,
		signal?: AbortSignal,
	): Promise<
		Result<{ frontmatter: Record<string, unknown>; body: string }, ParseFailure>
	> {
		throwIfAborted(signal);
		const readResult = await this.fs.readVaultText(file.path);

		if (isErr(readResult)) {
			this.log.warn(
				`Failed to read file during parseFile: ${file.path}`,
				readResult.error,
			);
			return err({
				kind: "YamlParseError",
				message: "Failed to read file",
			});
		}

		return noteCore.parseNoteContent(readResult.value);
	}

	/**
	 * [STATEFUL SHELL] Extracts minimal book metadata for indexing.
	 */
	public async extractMetadata(
		file: TFile,
		signal?: AbortSignal,
	): Promise<BookMetadata | null> {
		try {
			throwIfAborted(signal);
			const fm = await this.getFrontmatterFromFile(file, signal);
			return fm ? noteCore.extractBookMetadata(fm, file.path) : null;
		} catch (e) {
			if (!isAbortError(e)) {
				this.log.warn(`extractMetadata failed for ${file.path}`, e);
			}
			return null;
		}
	}

	/**
	 * [STATEFUL HELPER] Gets frontmatter from a file, prioritizing the metadata cache.
	 */
	private async getFrontmatterFromFile(
		file: TFile,
		signal?: AbortSignal,
	): Promise<Record<string, unknown> | null> {
		throwIfAborted(signal);
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache?.frontmatter) {
			return cache.frontmatter;
		}
		// Read partial content for performance if not cached
		const content = await this.readPartial(file, 4096);
		const parsed = noteCore.parseNoteContent(content);

		return !isErr(parsed) ? parsed.value.frontmatter : null;
	}

	// TODO: Optimize readPartial to read only the first few bytes instead of the entire file, to avoid unnecessary I/O and memory allocation for large files.
	private async readPartial(file: TFile, bytes: number): Promise<string> {
		const r = await this.fs.readVaultText(file.path);
		if (isErr(r)) {
			this.log.warn(`readPartial failed for ${file.path}`, r.error);
			return "";
		}
		return r.value.slice(0, bytes);
	}

	public async setFrontmatterFields(
		file: TFile,
		patch: Record<string, unknown>,
	): Promise<void> {
		return this.editFrontmatter(file, (fm) => {
			for (const [k, v] of Object.entries(patch)) {
				if (v === undefined) delete fm[k];
				else fm[k] = v;
			}
		});
	}
}
