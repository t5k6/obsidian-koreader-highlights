import type { App, TFile, TFolder } from "obsidian";
import { getOptimalConcurrency, runPool } from "src/lib/concurrency";
import { err, isErr, ok, type Result } from "src/lib/core/result";
import { isTFolder } from "src/lib/obsidian/typeguards";
import type { BookMetadata, KoreaderHighlightImporterSettings } from "src/types";
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

    const fileStream = this.iterateFiles({
      folder,
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
   * Returns all active, validated UIDs within the target folder.
   * Uses the same file traversal strategy as scanBooks, but avoids full metadata extraction.
   */
  public async getAllActiveUids(folder: string, signal?: AbortSignal): Promise<Set<string>> {
    const concurrency = getOptimalConcurrency();
    const fileStream = this.iterateFiles({
      folder,
      recursive: true,
      signal,
    });
    const pool = runPool(
      fileStream,
      async (file: TFile) => {
        signal?.throwIfAborted();
        return this.noteEditor.extractUid(file, signal);
      },
      { concurrency, signal },
    );
    const activeUids = new Set<string>();

    for await (const result of pool) {
      if (result.ok && result.value) {
        activeUids.add(result.value);
      }
    }

    return activeUids;
  }

  /**
   * Returns true as soon as the target UID is found in the scanned folder.
   * This is optimized for eager orphan checks.
   */
  public async isUidActive(
    targetUid: string,
    folder: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const fileStream = this.iterateFiles({
      folder,
      recursive: true,
      signal,
    });

    for await (const file of fileStream) {
      signal?.throwIfAborted();
      const uid = await this.noteEditor.extractUid(file, signal);
      if (uid === targetUid) {
        return true;
      }
    }

    return false;
  }

  /**
   * Convenience method that collects all results into arrays.
   * Use this for smaller datasets where memory usage is not a concern.
   */
  async scanAllMetadata(options: ScanOptions = {}): Promise<ScanResult<BookMetadata>> {
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

  private resolveRoot(folder: string): TFolder {
    const root =
      folder === "" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(folder);

    if (!isTFolder(root)) {
      throw new Error(`Highlights folder not found or not a directory: '${folder}'`);
    }

    return root;
  }

  private iterateFiles(
    options: Pick<ScanOptions, "folder" | "recursive" | "signal">,
  ): AsyncIterable<TFile> {
    const root = this.resolveRoot(options.folder ?? this.settings.highlightsFolder ?? "");
    return this.fs.iterateMarkdownFiles(root, {
      recursive: options.recursive ?? true,
      signal: options.signal,
    });
  }
}
