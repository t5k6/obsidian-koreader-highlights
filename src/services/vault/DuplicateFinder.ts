import {
	type App,
	normalizePath,
	type TAbstractFile,
	type TFile,
	type TFolder,
	type Vault,
} from "obsidian";
import { runPool } from "src/lib/concurrency";
import { isErr } from "src/lib/core/result";
import {
	analyzeAnnotations,
	sortDuplicateMatches,
} from "src/lib/duplicates/analysis";
import {
	buildExpectedFilenameKeys,
	filenameMatchesKeys,
	frontmatterMatchesBook,
} from "src/lib/duplicates/matching";
import { bookKeyFromDocProps } from "src/lib/formatting/formatUtils";
import { isTFile, isTFolder } from "src/lib/obsidian/typeguards";
import { extractHighlightsWithStyle } from "src/lib/parsing/highlightExtractor";
import { generateFileName } from "src/lib/pathing";
import type KoreaderImporterPlugin from "src/main";
import type { FrontmatterService } from "src/services/parsing/FrontmatterService";
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

export class DuplicateFinder implements SettingsObserver {
	private readonly log;

	constructor(
		private app: App,
		private vault: Vault,
		private plugin: KoreaderImporterPlugin,
		private localIndexService: IndexCoordinator,
		private fmService: FrontmatterService,
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
	): Promise<DuplicateScanResult> {
		// 1) Instant filename probe (unchanged)
		try {
			const expectedFileName = generateFileName(
				{
					useCustomTemplate: this.plugin.settings.useCustomFileNameTemplate,
					template: this.plugin.settings.fileNameTemplate,
				},
				luaMetadata.docProps,
				luaMetadata.originalFilePath,
			);
			const expectedPath = normalizePath(
				`${this.plugin.settings.highlightsFolder}/${expectedFileName}`,
			);
			const direct = this.app.vault.getAbstractFileByPath(expectedPath);
			if (isTFile(direct)) {
				const analysis = await this.analyzeDuplicate(
					direct,
					luaMetadata.annotations,
					luaMetadata,
				);
				this.log.info(
					`Found instant duplicate match via expected filename: ${expectedPath}`,
				);
				return { match: analysis, confidence: "full" };
			}
		} catch (e) {
			this.log.warn("Instant filename probe failed (continuing with scan)", e);
		}

		// 2) Index vs degraded path (unchanged decision)
		const bookKey = bookKeyFromDocProps(luaMetadata.docProps);
		const degraded =
			!this.localIndexService.isReady() ||
			this.localIndexService.isRebuildingIndex();

		if (!degraded) {
			const match = await this.findAndAnalyzeBest(
				() => this.findViaIndex(bookKey),
				luaMetadata,
			);
			return { match, confidence: "full" };
		}

		// 3) Degraded scan with controlled concurrency (unchanged structure; tuned limits)
		const scan = await this.scanVaultForKey(
			bookKey,
			luaMetadata.docProps,
			(this.plugin.settings.scanTimeoutSeconds ?? 8) * 1000,
		);

		const match = await this.findAndAnalyzeBest(
			() => Promise.resolve(scan.files),
			luaMetadata,
		);

		return { match, confidence: "partial" };
	}

	/**
	 * Unified pipeline: get candidates → analyze (batched) → sort → best
	 * Uses bounded concurrency for analysis to avoid I/O bursts on large sets.
	 */
	private async findAndAnalyzeBest(
		fileProvider: () => Promise<TFile[]>,
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch | null> {
		const candidateFiles = await fileProvider();
		if (candidateFiles.length === 0) return null;

		const ANALYSIS_CONCURRENCY =
			typeof navigator !== "undefined" && (navigator as any).hardwareConcurrency
				? Math.min(
						6,
						Math.max(2, Math.floor((navigator as any).hardwareConcurrency / 2)),
					)
				: 4;

		const analyses = await runPool(
			candidateFiles,
			ANALYSIS_CONCURRENCY,
			(file) =>
				this.analyzeDuplicate(file, luaMetadata.annotations, luaMetadata),
		);

		const [best] = sortDuplicateMatches(
			analyses,
			this.plugin.settings.highlightsFolder,
		);
		return best ?? null;
	}

	/**
	 * Find via index (no local cache; rely on IndexCoordinator caching).
	 */
	private async findViaIndex(bookKey: string): Promise<TFile[]> {
		try {
			const paths = await this.localIndexService.findExistingBookFiles(bookKey);
			const files: TFile[] = [];
			for (const p of paths) {
				const f = this.vault.getAbstractFileByPath(p);
				if (isTFile(f)) files.push(f);
			}
			return files;
		} catch (e) {
			this.log.warn("Index query failed", e);
			return [];
		}
	}

	/**
	 * Degraded scan with adaptive concurrency limits and timeout.
	 */
	private async scanVaultForKey(
		bookKey: string,
		docProps: DocProps,
		timeoutMs: number,
	): Promise<{ files: TFile[]; timedOut: boolean }> {
		const settingsFolder = this.plugin.settings.highlightsFolder ?? "";

		let root: TFolder | TAbstractFile | null;
		if (settingsFolder === "") {
			root = this.vault.getRoot();
		} else {
			root = this.vault.getAbstractFileByPath(settingsFolder);
		}

		if (!isTFolder(root)) {
			this.log.warn(
				`Highlights folder not found or not a directory: '${settingsFolder}'`,
			);
			return { files: [], timedOut: false };
		}

		// Stage 1: collect files with a timeout signal
		const collectionSignal = AbortSignal.timeout(timeoutMs);
		const { files: potentialDuplicates, aborted: collectionAborted } =
			await this.fs.getFilesInFolder(root, {
				extensions: ["md"],
				recursive: true,
				signal: collectionSignal,
			});

		const expectedFilenameKeys = buildExpectedFilenameKeys(docProps);
		if (collectionAborted) {
			this.log.warn(
				`Degraded duplicate scan was aborted during file collection.`,
			);
			return { files: [], timedOut: true };
		}

		// Stage 2: filter candidates with adaptive concurrency under a separate timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			this.log.warn(`Duplicate scan timed out after ${timeoutMs}ms.`);
			controller.abort();
		}, timeoutMs);

		// Adaptive, clamped concurrency to avoid I/O thrash on big vaults
		const hc =
			typeof navigator !== "undefined" && (navigator as any).hardwareConcurrency
				? (navigator as any).hardwareConcurrency
				: 4;
		const poolConcurrency = Math.min(8, Math.max(2, Math.ceil(hc / 2)));

		const SEQUENTIAL_THRESHOLD = 100;
		try {
			if (potentialDuplicates.length < SEQUENTIAL_THRESHOLD) {
				const matched: TFile[] = [];
				for (const file of potentialDuplicates) {
					if (controller.signal.aborted) break;
					const res = await this._isPotentialMatch(
						file,
						bookKey,
						expectedFilenameKeys,
					);
					if (res) matched.push(res);
				}
				return { files: matched, timedOut: controller.signal.aborted };
			}

			const results = await runPool(
				potentialDuplicates,
				poolConcurrency,
				(file) => this._isPotentialMatch(file, bookKey, expectedFilenameKeys),
				controller.signal,
			);
			const matchedFiles = results.filter((f): f is TFile => f !== null);
			return { files: matchedFiles, timedOut: controller.signal.aborted };
		} catch (error) {
			if (controller.signal.aborted) {
				return { files: [], timedOut: true };
			}
			this.log.error("Unexpected error during parallel duplicate scan", error);
			return { files: [], timedOut: false };
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private async _isPotentialMatch(
		file: TFile,
		bookKey: string,
		expectedFilenameKeys: Set<string>,
	): Promise<TFile | null> {
		try {
			// Frontmatter fast-path
			const cachedMetadata = this.app.metadataCache.getFileCache(file);
			const fm = cachedMetadata?.frontmatter as
				| { title?: unknown; authors?: unknown }
				| undefined;

			if (frontmatterMatchesBook(fm, bookKey)) {
				return file;
			}

			// Filename heuristic fallback
			if (filenameMatchesKeys(file.basename, expectedFilenameKeys)) {
				return file;
			}
		} catch (e) {
			this.log.warn(`Error processing ${file.path} during duplicate scan.`, e);
		}
		return null;
	}

	private async analyzeDuplicate(
		existingFile: TFile,
		newAnnotations: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch> {
		const parsed = await this.fmService.parseFile(existingFile);
		const existingBody = parsed.body;

		const { annotations: existingHighlights }: { annotations: Annotation[] } =
			extractHighlightsWithStyle(
				existingBody,
				this.plugin.settings.commentStyle,
			);

		const { newHighlights, modifiedHighlights, matchType } = analyzeAnnotations(
			existingHighlights,
			newAnnotations,
		);

		let canMergeSafely = false;
		let expectedUid: string | undefined;
		try {
			expectedUid = this.persistence.tryGetId(existingFile);
			if (expectedUid) {
				const snapRes = await this.persistence.readSnapshotById(expectedUid);
				canMergeSafely = !isErr(snapRes);
			}
		} catch {
			canMergeSafely = false;
		}

		return {
			file: existingFile,
			matchType,
			newHighlights,
			modifiedHighlights,
			luaMetadata,
			expectedUid,
			canMergeSafely,
		};
	}

	public async analyzeExistingFile(
		existingFile: TFile,
		luaMetadata: LuaMetadata,
	): Promise<DuplicateMatch> {
		return this.analyzeDuplicate(
			existingFile,
			luaMetadata.annotations,
			luaMetadata,
		);
	}

	public invalidateCaches(): void {
		// Centralize cache ownership in IndexCoordinator
		this.localIndexService.invalidateIndexCaches();
	}

	// Kept for API compatibility; now a no-op.
	public clearCache(): void {
		/* no-op: cache moved to IndexCoordinator */
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
}
