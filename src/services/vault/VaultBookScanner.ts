import type { App, TFile } from "obsidian";
import { getOptimalConcurrency, runPool } from "src/lib/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import { isTFolder } from "src/lib/obsidian/typeguards";
import type {
	BookMetadata,
	KoreaderHighlightImporterSettings,
} from "src/types";
import type { FileSystemService } from "../FileSystemService";
import type { NoteEditorService } from "../parsing/NoteEditorService";

export interface ScanOk {
	file: TFile;
	metadata: BookMetadata;
}

export interface ScanError {
	file: TFile;
	error: unknown;
}

export type ScanItem = Result<ScanOk, ScanError>;

export interface ScanOptions {
	folder?: string; // defaults to settings.highlightsFolder
	recursive?: boolean; // defaults to true
	concurrency?: number; // defaults to optimal
	signal?: AbortSignal;
	onProgress?: (processed: number) => void;
}

export interface ScanResult<T> {
	items: T[];
	errors: { file: string; error: unknown }[];
	processed: number;
	failed: number;
}

/**
 * A streaming-first utility for scanning vault markdown files and extracting book metadata.
 * Consolidates the duplicated scanning logic from DuplicateFinder and IndexDatabase.
 */
export class VaultBookScanner {
	constructor(
		private readonly app: App,
		private readonly fs: FileSystemService,
		private readonly noteEditor: NoteEditorService,
		private readonly settings: KoreaderHighlightImporterSettings,
	) {}

	/**
	 * Core streaming method that yields { file, metadata } or ScanError as they are processed.
	 * Use this for memory-efficient processing of large vaults.
	 */
	async *scanBooks(options: ScanOptions = {}): AsyncIterable<ScanItem> {
		const {
			folder = this.settings.highlightsFolder || "",
			recursive = true,
			concurrency = getOptimalConcurrency(),
			signal,
			onProgress,
		} = options;

		const root =
			folder === ""
				? this.app.vault.getRoot()
				: this.app.vault.getAbstractFileByPath(folder);

		if (!isTFolder(root)) {
			throw new Error(
				`Highlights folder not found or not a directory: '${folder}'`,
			);
		}

		const fileStream = this.fs.iterateMarkdownFiles(root, {
			recursive,
			signal,
		});

		const pool = runPool(
			fileStream,
			async (file: TFile): Promise<ScanOk> => {
				signal?.throwIfAborted();

				const metadata = await this.noteEditor.extractMetadata(file, signal);
				if (!metadata) {
					throw new Error("No metadata extracted");
				}
				return { file, metadata };
			},
			{ concurrency, signal },
		);

		let processed = 0;
		for await (const r of pool) {
			processed++;
			onProgress?.(processed);

			if (r.ok) {
				// r.value is ScanOk
				yield ok(r.value);
			} else {
				const { item: file, error } = r.error;
				const scanError: ScanError = { file, error };
				yield err(scanError);
			}
		}
	}

	/**
	 * Convenience method that collects all results into arrays.
	 * Use this for smaller datasets where memory usage is not a concern.
	 */
	async scanAllMetadata(
		options: ScanOptions = {},
	): Promise<ScanResult<BookMetadata>> {
		const stream = this.scanBooks(options);
		const items: BookMetadata[] = [];
		const errors: { file: string; error: unknown }[] = [];
		let processed = 0;

		for await (const result of stream) {
			processed++;
			if (isErr(result)) {
				errors.push({
					file: result.error.file.path,
					error: result.error.error,
				});
			} else {
				items.push(result.value.metadata);
			}
		}

		return { items, errors, processed, failed: errors.length };
	}
}
