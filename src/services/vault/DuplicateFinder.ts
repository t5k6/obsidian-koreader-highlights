import type { App, TFile, Vault } from "obsidian";
import {
	getOptimalConcurrency,
	isAbortError,
	runPool,
	throwIfAborted,
} from "src/lib/concurrency";
import { runConcurrentScan, type ScanResult } from "src/lib/concurrency/scan";
import { isErr } from "src/lib/core/result";
import {
	buildExpectedFilenameKeys,
	createDuplicateMatch,
	isPotentialMatch,
	sortDuplicateMatches,
} from "src/lib/duplicatesCore";
import { bookKeyFromDocProps } from "src/lib/formatting/formatUtils";
import { isTFile, isTFolder } from "src/lib/obsidian/typeguards";
import { extractHighlightsAuto } from "src/lib/parsing/highlightExtractor";
import { generateFileName, Pathing } from "src/lib/pathing";
import type KoreaderImporterPlugin from "src/main";
import type { NoteEditorService } from "src/services/parsing/NoteEditorService";
import type {
	Annotation,
	DocProps,
	DuplicateMatch,
	DuplicateScanResult,
	KoreaderHighlightImporterSettings,
	LuaMetadata,
	SettingsObserver,
} from "src/types";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { IndexCoordinator } from "./index/IndexCoordinator";
import type { NotePersistenceService } from "./NotePersistenceService";

type FindResult = ScanResult<TFile>;
type FrontmatterForMatch = { title?: string; authors?: string | string[] };

export class DuplicateFinder implements SettingsObserver {
	private readonly log;

	constructor(
		private app: App,
		private vault: Vault,
		private plugin: KoreaderImporterPlugin,
		private localIndexService: IndexCoordinator,
		private noteEditorService: NoteEditorService,
		private persistence: NotePersistenceService,
		private loggingService: LoggingService,
		private fs: FileSystemService,
	) {
		this.log = this.loggingService.scoped("DuplicateFinder");

		this.plugin.registerEvent(
			this.vault.on("rename", () => this.invalidateCaches()),
		);
		this.plugin.registerEvent(
			this.vault.on("delete", () => this.invalidateCaches()),
		);
	}

	public async findBestMatch(
		luaMetadata: LuaMetadata,
		degradedScanCache?: Map<string, TFile[]> | null,
	): Promise<DuplicateScanResult> {
		const bookKey = bookKeyFromDocProps(luaMetadata.docProps);

		const directCandidates = await this._findViaDirectProbe(luaMetadata);
		if (directCandidates.length > 0) {
			const match = await this._findAndAnalyzeBest(
				directCandidates,
				luaMetadata,
			);
			if (match) {
				this.log.info(
					`Found instant duplicate match via expected filename: ${match.file.path}`,
				);
				return { match, confidence: "full" };
			}
		}

		const useIndex =
			this.localIndexService.isReady() &&
			!this.localIndexService.isRebuildingIndex();

		if (useIndex) {
			const indexCandidates = await this._findViaIndex(bookKey);
			const match = await this._findAndAnalyzeBest(
				indexCandidates,
				luaMetadata,
			);
			return { match, confidence: "full" };
		}

		this.log.warn("Index is unavailable. Falling back to degraded vault scan.");

		let confidence: "full" | "partial" = "partial";
		let scanCandidates: TFile[];

		if (degradedScanCache) {
			scanCandidates = degradedScanCache.get(bookKey) ?? [];
		} else {
			const scanResult = await this.scanVaultForKey(
				bookKey,
				luaMetadata.docProps,
				this.plugin.settings.scanTimeoutSeconds * 1000,
			);
			scanCandidates = scanResult.files;
			if (scanResult.timedOut) {
				confidence = "partial";
			}
		}

		const match = await this._findAndAnalyzeBest(scanCandidates, luaMetadata);
		return { match, confidence };
	}

	public async scanVaultForKey(
		bookKey: string,
		docProps: DocProps,
		timeoutMs: number,
	): Promise<{ files: TFile[]; timedOut: boolean }> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const result = await this._runDegradedScan(
				bookKey,
				docProps,
				controller.signal,
			);
			// Handle the race condition where the scan finishes *after* the
			// timeout has been triggered but *before* an AbortError is thrown.
			// We check the signal's state directly upon completion.
			if (controller.signal.aborted) {
				return {
					files:
						result.kind === "complete" ? result.items : result.partialItems,
					timedOut: true,
				};
			}
			if (result.kind === "complete") {
				return { files: result.items, timedOut: false };
			}
			return { files: result.partialItems, timedOut: true };
		} catch (e) {
			if (!isAbortError(e)) {
				this.log.error("Unexpected error during degraded scan", e);
			}
			return { files: [], timedOut: isAbortError(e) };
		} finally {
			clearTimeout(timeoutId);
		}
	}

	public async analyzeCandidateFile(
		file: TFile,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch> {
		const parsed = await this.noteEditorService.parseFile(file);
		const existingHighlights = parsed.ok
			? extractHighlightsAuto(parsed.value.body).annotations
			: [];
		const expectedUid = this.persistence.tryGetId(file);
		const snapRes = expectedUid
			? await this.persistence.readSnapshotById(expectedUid)
			: null;

		const canMergeSafely = !!snapRes && !isErr(snapRes);

		return createDuplicateMatch(
			file,
			existingHighlights,
			newAnnotations,
			luaMetadata,
			canMergeSafely,
			expectedUid,
		);
	}

	private async _runDegradedScan(
		bookKey: string,
		docProps: DocProps,
		signal: AbortSignal,
	): Promise<FindResult> {
		const highlightsFolder = this.plugin.settings.highlightsFolder || "";
		const root =
			highlightsFolder === ""
				? this.vault.getRoot()
				: this.vault.getAbstractFileByPath(highlightsFolder);

		if (!isTFolder(root)) {
			this.log.warn(
				`Highlights folder not found or not a directory: '${highlightsFolder}'`,
			);
			return { kind: "complete", items: [] };
		}

		const expectedFilenameKeys = buildExpectedFilenameKeys(docProps);

		const fileStream = this.fs.iterateMarkdownFiles(root, {
			recursive: true,
			signal,
		});

		return await runConcurrentScan(
			fileStream,
			async (file: TFile) => {
				throwIfAborted(signal); // Always check for cancellation first.

				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
					| FrontmatterForMatch
					| undefined;

				// Fast path: Check heuristics first.
				if (
					isPotentialMatch(fm, file.basename, bookKey, expectedFilenameKeys)
				) {
					return file;
				}

				// Slow path: If heuristics fail, perform a full metadata extraction.
				try {
					const md = await this.noteEditorService.extractMetadata(file, signal);
					if (md?.key === bookKey) {
						return file;
					}
				} catch (e) {
					// Re-throw AbortError to allow cancellation to propagate.
					if (isAbortError(e)) {
						throw e;
					}
					// Log other errors but do not crash the entire scan.
					this.log.warn(
						`Metadata extraction failed for ${file.path} during scan`,
						e,
					);
				}

				return null;
			},
			{ signal },
		);
	}

	private async _findViaDirectProbe(
		luaMetadata: LuaMetadata,
	): Promise<TFile[]> {
		try {
			const expectedFileName = generateFileName(
				{
					useCustomTemplate: this.plugin.settings.useCustomFileNameTemplate,
					template: this.plugin.settings.fileNameTemplate,
				},
				luaMetadata.docProps,
				luaMetadata.originalFilePath,
			);
			const expectedPath = Pathing.toVaultPath(
				`${this.plugin.settings.highlightsFolder}/${expectedFileName}`,
			);
			const file = this.app.vault.getAbstractFileByPath(expectedPath);
			return isTFile(file) ? [file] : [];
		} catch (e) {
			this.log.warn("Direct filename probe failed", e);
			return [];
		}
	}

	private async _findViaIndex(bookKey: string): Promise<TFile[]> {
		try {
			const paths = await this.localIndexService.findExistingBookFiles(bookKey);
			return paths
				.map((p) => this.vault.getAbstractFileByPath(p))
				.filter(isTFile);
		} catch (e) {
			this.log.warn("Index query failed", e);
			return [];
		}
	}

	private async _findAndAnalyzeBest(
		candidateFiles: TFile[],
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch | null> {
		if (candidateFiles.length === 0) return null;

		const analyses: DuplicateMatch[] = [];
		const stream = runPool(
			candidateFiles,
			(file) =>
				this.analyzeCandidateFile(file, luaMetadata.annotations, luaMetadata),
			{ concurrency: getOptimalConcurrency({ factor: 0.5, max: 6 }) },
		);

		for await (const result of stream) {
			if (result.ok) {
				analyses.push(result.value);
			} else {
				this.log.warn(`Failed to analyze duplicate candidate`, result.error);
			}
		}

		const [best] = sortDuplicateMatches(
			analyses,
			this.plugin.settings.highlightsFolder,
		);
		return best ?? null;
	}

	public onSettingsChanged(
		newSettings: KoreaderHighlightImporterSettings,
		oldSettings?: KoreaderHighlightImporterSettings,
	): void {
		if (
			!oldSettings ||
			newSettings.highlightsFolder !== oldSettings.highlightsFolder
		) {
			this.invalidateCaches();
			this.log.info("Settings changed: invalidated index caches");
		}
	}

	public invalidateCaches(): void {
		this.localIndexService.invalidateIndexCaches();
	}

	public async buildDegradedScanCache(): Promise<Map<string, TFile[]>> {
		this.log.info("Building degraded scan cache by pre-scanning the vault...");
		const highlightsFolder =
			this.plugin.settings.highlightsFolder ?? this.app.vault.getRoot().path;
		const files = await this.fs.listMarkdownFiles(highlightsFolder, {
			recursive: true,
		});

		const results = new Map<string, TFile[]>();
		const concurrency = getOptimalConcurrency();

		const stream = runPool(
			files,
			async (file: TFile) => {
				const metadata = await this.noteEditorService.extractMetadata(file);
				if (metadata?.key) {
					return { key: metadata.key, file };
				}
				return null;
			},
			{ concurrency },
		);

		for await (const result of stream) {
			if (result.ok && result.value) {
				const { key, file } = result.value;
				const existing = results.get(key) ?? [];
				existing.push(file);
				results.set(key, existing);
			}
		}
		this.log.info(
			`Pre-scan complete. Found potential duplicates for ${results.size} unique books.`,
		);
		return results;
	}
}
