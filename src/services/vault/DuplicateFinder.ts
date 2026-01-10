import type { App, TFile, Vault } from "obsidian";
import {
	getOptimalConcurrency,
	isAbortError,
	runPool,
	throwIfAborted,
} from "src/lib/concurrency";
import type { ScanResult } from "src/lib/concurrency/scan";
import { isErr } from "src/lib/core/result";
import {
	buildExpectedFilenameKeys,
	createDuplicateMatch,
	isPotentialMatch,
	sortDuplicateMatches,
} from "src/lib/duplicatesCore";
import {
	buildBookKey,
	getStrongIdentifiers,
	isUniqueMd5,
} from "src/lib/metadata/identity";
import { isTFile, isTFolder } from "src/lib/obsidian/typeguards";
import { extractHighlightsAuto } from "src/lib/parsing/highlightExtractor";
import { Pathing } from "src/lib/pathing";
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
import type { DeviceService } from "../device/DeviceService";
import type { FileSystemService } from "../FileSystemService";
import type { LoggingService } from "../LoggingService";
import type { IndexCoordinator } from "./index/IndexCoordinator";
import type { NotePersistenceService } from "./NotePersistenceService";
import type { VaultBookScanner } from "./VaultBookScanner";

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
		private vaultBookScanner: VaultBookScanner,
		private deviceService: DeviceService,
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
		const bookKey = buildBookKey(luaMetadata.docProps);

		// Priority 1: Direct filename probe (fastest, most specific)
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

		// Priority 2: Strong identifiers from KOReader metadata
		const strongIds = getStrongIdentifiers(luaMetadata.docProps);
		if (strongIds.length > 0) {
			const candidates = await this._findViaStrongIdentifiers(strongIds);
			if (candidates.length > 0) {
				const match = await this._findAndAnalyzeBest(candidates, luaMetadata);
				if (match) {
					this.log.info(
						`Found duplicate match via strong identifiers (${strongIds.map((id) => id.scheme).join(", ")}): ${match.file.path}`,
					);
					return { match, confidence: "full" };
				}
			}
		}

		// Priority 3: Unique MD5 from KOReader stats
		const md5 = luaMetadata.md5 ?? luaMetadata.statistics?.book.md5;
		if (md5 && (await this._isMd5UniqueInStats(md5))) {
			const candidates = await this._findViaUniqueMd5(md5);
			if (candidates.length > 0) {
				const match = await this._findAndAnalyzeBest(candidates, luaMetadata);
				if (match) {
					this.log.info(
						`Found duplicate match via unique MD5 (${md5.slice(0, 8)}...): ${match.file.path}`,
					);
					return { match, confidence: "full" };
				}
			}
		}

		// Priority 4: Index lookup by normalized book key
		const useIndex =
			this.localIndexService.isReady() &&
			!this.localIndexService.isRebuildingIndex();

		if (useIndex) {
			const indexCandidates = await this._findViaIndex(bookKey);
			if (indexCandidates.length > 0) {
				const match = await this._findAndAnalyzeBest(
					indexCandidates,
					luaMetadata,
				);
				if (match) {
					return { match, confidence: "full" };
				}
			}
		}

		// Fallback: Degraded vault scan
		this.log.warn(
			"No matches found via priority methods. Falling back to degraded vault scan.",
		);

		let confidence: "full" | "partial" = "partial";
		let scanCandidates: TFile[];

		if (degradedScanCache) {
			scanCandidates = degradedScanCache.get(bookKey) ?? [];
			// Cache represents complete scan results, so we're confident
			confidence = "full";
		} else {
			const scanResult = await this.scanVaultForKey(
				bookKey,
				luaMetadata.docProps,
				this.plugin.settings.scanTimeoutSeconds * 1000,
			);
			scanCandidates = scanResult.files;
			if (!scanResult.timedOut) {
				confidence = "full";
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
		const expectedFilenameKeys = buildExpectedFilenameKeys(docProps);
		const matches: TFile[] = [];

		const folder = this.plugin.settings.highlightsFolder || "";
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
			recursive: true,
			signal,
		});

		try {
			for await (const file of fileStream) {
				throwIfAborted(signal); // Always check for cancellation first.

				const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
					| FrontmatterForMatch
					| undefined;

				// Check if file matches via frontmatter or filename heuristic.
				if (
					isPotentialMatch(fm, file.basename, bookKey, expectedFilenameKeys)
				) {
					matches.push(file);
				}
			}
		} catch (e) {
			if (!isAbortError(e)) {
				this.log.error("Unexpected error during degraded scan", e);
			}
			// For AbortError, we still return partial results
		}

		return { kind: "complete", items: matches };
	}

	private async _findViaDirectProbe(
		luaMetadata: LuaMetadata,
	): Promise<TFile[]> {
		try {
			const expectedFileName = Pathing.generateFileName(
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

		const scanResult = await this.vaultBookScanner.scanAllMetadata();
		const results = new Map<string, TFile[]>();

		for (const metadata of scanResult.items) {
			const existing = results.get(metadata.key) ?? [];
			const file = this.vault.getAbstractFileByPath(metadata.vaultPath);
			if (isTFile(file)) {
				existing.push(file);
				results.set(metadata.key, existing);
			}
		}

		this.log.info(
			`Pre-scan complete. Found potential duplicates for ${results.size} unique books.`,
		);
		return results;
	}

	/**
	 * Find existing notes that match strong identifiers from KOReader stats DB.
	 * This queries the KOReader database for books with matching identifiers,
	 * then finds existing notes that correspond to those books.
	 */
	private async _findViaStrongIdentifiers(
		strongIds: import("src/lib/metadata/identity").ParsedIdentifier[],
	): Promise<TFile[]> {
		try {
			// Filter to only identifiers with valid schemes
			const validIds = strongIds.filter((id) => id.scheme != null);
			if (validIds.length === 0) return [];

			// Query KOReader stats DB for books with matching identifiers
			const statsBooks = await this.deviceService.queryBooksByIdentifiers(
				validIds as { scheme: string; value: string }[],
			);
			if (statsBooks.length === 0) return [];

			// For each matching book, find existing notes via their MD5 or other keys
			const candidates: TFile[] = [];
			for (const book of statsBooks) {
				// Try to find notes by MD5 first
				if (book.md5) {
					const md5Candidates = await this._findViaUniqueMd5(book.md5);
					candidates.push(...md5Candidates);
				}
				// Could also try by title/author if needed, but MD5 should be sufficient
			}

			return candidates;
		} catch (e) {
			this.log.warn("Failed to find via strong identifiers", e);
			return [];
		}
	}

	/**
	 * Check if an MD5 is unique in the KOReader stats database.
	 */
	private async _isMd5UniqueInStats(md5: string): Promise<boolean> {
		try {
			const count = await this.deviceService.getMd5OccurrenceCount(md5);
			return isUniqueMd5(md5, count);
		} catch (e) {
			this.log.warn(`Failed to check MD5 uniqueness for ${md5}`, e);
			return false;
		}
	}

	/**
	 * Find existing notes that were imported with a specific MD5.
	 * This queries the import_source table in the plugin's index.
	 */
	private async _findViaUniqueMd5(md5: string): Promise<TFile[]> {
		try {
			const sourceRows =
				await this.localIndexService.getImportSourcesByMd5(md5);
			const candidates: TFile[] = [];

			for (const row of sourceRows) {
				if (row.book_key) {
					const paths = await this.localIndexService.findExistingBookFiles(
						row.book_key,
					);
					const files = paths
						.map((p) => this.vault.getAbstractFileByPath(p))
						.filter(isTFile);
					candidates.push(...files);
				}
			}

			return candidates;
		} catch (e) {
			this.log.warn(`Failed to find via MD5 ${md5}`, e);
			return [];
		}
	}
}
