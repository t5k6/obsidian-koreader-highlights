import { stat } from "node:fs/promises";
import { normalizePath, Notice, Plugin, TFile } from "obsidian";
import { DuplicateHandler } from "./duplicateHandler";
import { DuplicateHandlingModal } from "./duplicateModal";
import { createFrontmatterData, formatFrontmatter } from "./frontmatter";
import { findSDRFiles, readSDRFileContent } from "./parser";
import { KoReaderSettingTab } from "./settings";
import {
	type Annotation,
	DEFAULT_SETTINGS,
	type DocProps,
	type DuplicateChoice,
	type KoReaderHighlightImporterSettings,
	type LuaMetadata,
} from "./types";
import {
	devError,
	devLog,
	ensureParentDirectory,
	formatHighlight,
	generateUniqueFilePath,
	getFileNameWithoutExt,
	handleDirectoryError,
	initLogging,
	setDebugMode,
} from "./utils";
// import { testDatabase } from "./test-db"; // For debugging/testing

// Caches for SDR file paths and parsed metadata
const sdrFilesCache = new Map<string, string[]>();
const parsedMetadataCache = new Map<string, LuaMetadata>();

export default class KoReaderHighlightImporter extends Plugin {
	settings: KoReaderHighlightImporterSettings = DEFAULT_SETTINGS;
	duplicateHandler!: DuplicateHandler;

	// --- Initialization & Settings ---

	async onload() {
		console.log("KoReader Importer Plugin: onload() started");
		// await testDatabase().catch((err) => console.error("Error in testDatabase():", err));
		await this.loadSettings();
		setDebugMode(this.settings.debugMode);

		this.addCommand({
			id: "import-koreader-highlights",
			name: "Import",
			callback: () => this.handleImportHighlights(),
		});

		this.addCommand({
			id: "scan-koreader-highlights",
			name: "Scan",
			callback: () => this.handleScanHighlightsDirectory(),
		});

		this.addSettingTab(new KoReaderSettingTab(this.app, this));

		this.duplicateHandler = new DuplicateHandler(
			this.app.vault,
			this.app,
			(app, match, message) =>
				new DuplicateHandlingModal(app, match, message),
			this.settings,
		);

		if (this.settings.debugMode) {
			try {
				const logFilePath = await initLogging(
					this.app.vault,
					"Koreader_Importer_Logs",
				);
				console.log("Log file initialized at:", logFilePath);
			} catch (error) {
				console.error("Failed to initialize logging:", error);
			}
		}
	}

	onunload() {
		sdrFilesCache.clear();
		parsedMetadataCache.clear();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
		if (!this.settings.koboMountPoint) {
			new Notice(
				"KOReader Importer: Please specify your KoReader mount point in the plugin settings.",
			);
		}
		// Ensure settings are arrays
		if (!Array.isArray(this.settings.excludedFolders)) {
			new Notice(
				"KOReader Importer: Excluded folders setting should be an array.",
			);
			this.settings.excludedFolders = [];
		}
		if (!Array.isArray(this.settings.allowedFileTypes)) {
			new Notice(
				"KOReader Importer: Allowed file types setting should be an array.",
			);
			this.settings.allowedFileTypes = [];
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// --- Mount Point & SDR Files ---

	private async checkMountPoint(): Promise<boolean> {
		if (!this.settings.koboMountPoint) {
			new Notice(
				"KOReader Importer: Please specify your KoReader mount point in the plugin settings.",
			);
			return false;
		}
		try {
			const stats = await stat(this.settings.koboMountPoint);
			if (!stats.isDirectory()) {
				new Notice(
					"KOReader Importer: The specified mount point is not a directory.",
				);
				return false;
			}
			devLog(
				"Kobo mount point is accessible:",
				this.settings.koboMountPoint,
			);
			return true;
		} catch (error) {
			handleDirectoryError(
				this.settings.koboMountPoint,
				error as NodeJS.ErrnoException,
			);
			new Notice(
				"KOReader Importer: Please check the mount point in the plugin settings.",
			);
			return false;
		}
	}

	private getCacheKey(): string {
		return `${this.settings.koboMountPoint}:${
			this.settings.excludedFolders.join(",")
		}:${this.settings.allowedFileTypes.join(",")}`;
	}

	private async ensureMountPointAndSDRFiles(): Promise<string[]> {
		if (!(await this.checkMountPoint())) return [];
		const cacheKey = this.getCacheKey();
		let sdrFiles = sdrFilesCache.get(cacheKey);
		if (!sdrFiles) {
			sdrFiles = await findSDRFiles(
				this.settings.koboMountPoint,
				this.settings.excludedFolders,
				this.settings.allowedFileTypes,
			);
			sdrFilesCache.set(cacheKey, sdrFiles);
		}
		if (sdrFiles.length === 0) {
			new Notice("No .sdr directories found.");
		}
		return sdrFiles;
	}

	// --- Commands: Import & Scan ---

	async handleImportHighlights() {
		if (!(await this.checkMountPoint())) return;
		try {
			await this.importHighlights();
		} catch (error) {
			devError("Error importing highlights:", error);
			new Notice(
				"KOReader Importer: Error importing highlights. Check the console for details.",
			);
		}
	}

	async handleScanHighlightsDirectory() {
		if (!(await this.checkMountPoint())) return;
		try {
			await this.scanHighlightsDirectory();
		} catch (error) {
			devError("Error scanning for highlights:", error);
			new Notice(
				"KOReader Importer: Error scanning for highlights. Check the console for details.",
			);
		}
	}

	async importHighlights() {
		if (!(await this.checkMountPoint())) return;

		const sdrFiles = await this.ensureMountPointAndSDRFiles();
		if (!sdrFiles.length) return;

		for (const file of sdrFiles) {
			try {
				let luaMetadata = parsedMetadataCache.get(file);
				if (!luaMetadata) {
					luaMetadata = await readSDRFileContent(
						file,
						this.settings.allowedFileTypes,
						this.settings.frontmatter,
					);
					parsedMetadataCache.set(file, luaMetadata);
				}

				// Fallback: use file name as author/title if missing
				if (
					luaMetadata.docProps.authors === "" &&
					luaMetadata.docProps.title === ""
				) {
					luaMetadata.docProps.authors = getFileNameWithoutExt(file);
				}
				devLog(
					`Importing highlights for: ${luaMetadata.docProps.title} from ${luaMetadata.docProps.authors}`,
				);
				await this.saveHighlights(
					luaMetadata.annotations || [],
					luaMetadata,
				);
			} catch (error) {
				this.handleFileError(error, file);
			}
		}
		new Notice("KOReader Importer: Highlights imported successfully!");
	}

	private async saveHighlights(
		highlights: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<void> {
		if (highlights.length === 0) return;

		const fileName = this.generateFileName(luaMetadata.docProps);
		const filePath = normalizePath(
			`${this.settings.highlightsFolder}/${fileName}`,
		);
		const frontmatter = this.generateFrontmatter(luaMetadata);
		const content = frontmatter +
			this.generateHighlightsContent(highlights);

		try {
			let fileCreated = false;
			if (this.settings.enableFullDuplicateCheck) {
				// Check for duplicates and process them
				const potentialDuplicates = await this.duplicateHandler
					.findPotentialDuplicates(luaMetadata.docProps);
				if (potentialDuplicates.length > 0) {
					fileCreated = await this.handleDuplicates(
						potentialDuplicates,
						highlights,
						luaMetadata,
						content,
					);
				}
				// If no duplicates, create the file
				if (!fileCreated && potentialDuplicates.length === 0) {
					await this.createOrUpdateFile(filePath, content);
				}
			} else {
				await this.createOrUpdateFile(filePath, content);
			}
		} catch (error) {
			devError(
				`Error saving highlights for ${luaMetadata.docProps.title}:`,
				error,
			);
			new Notice(
				`KOReader Importer: Error saving highlights for ${luaMetadata.docProps.title}. See console for details.`,
			);
		}
	}

	private async handleDuplicates(
		potentialDuplicates: unknown[],
		highlights: Annotation[],
		luaMetadata: LuaMetadata,
		content: string,
	): Promise<boolean> {
		let fileCreated = false;
		let applyToAll = false;
		let applyToAllChoice: DuplicateChoice | null = null;

		// Analyze all duplicates concurrently
		const analyses = await Promise.all(
			potentialDuplicates.map((duplicate) => {
				if (this.isTFile(duplicate)) {
					return this.duplicateHandler.analyzeDuplicate(
						duplicate,
						highlights,
						luaMetadata,
					);
				}
				throw new Error("Duplicate is not of type TFile");
			}),
		);

		// Process each duplicate sequentially
		for (const analysis of analyses) {
			if (applyToAll && applyToAllChoice !== null) {
				const { choice } = await this.duplicateHandler.handleDuplicate(
					analysis,
					content,
				);
				if (choice !== "skip") fileCreated = true;
				continue;
			}

			this.duplicateHandler.currentMatch = analysis;
			const { choice, applyToAll: userChoseApplyToAll } = await this
				.duplicateHandler.handleDuplicate(analysis, content);
			if (choice !== "skip") fileCreated = true;
			if (userChoseApplyToAll) {
				applyToAll = true;
				applyToAllChoice = choice;
			}
		}
		return fileCreated;
	}

	// Add a type guard function to check if an object is a TFile
	private isTFile(obj: unknown): obj is TFile {
		return obj instanceof TFile;
	}

	async scanHighlightsDirectory(): Promise<void> {
		const sdrFiles = await this.ensureMountPointAndSDRFiles();
		if (!sdrFiles.length) return;
		try {
			await this.createOrUpdateNote(sdrFiles);
			new Notice("SDR directories listed in KoReader SDR Files.md");
		} catch (error) {
			devError("Error updating SDR directories note:", error);
			new Notice(
				"KOReader Importer: Error updating SDR directories note. Check the console for details.",
			);
		}
	}

	private async createOrUpdateNote(sdrFiles: string[]): Promise<void> {
		const filePath = await generateUniqueFilePath(
			this.app.vault,
			"",
			"KoReader SDR Files.md",
		);
		const content = `# KoReader SDR Files\n\n${
			sdrFiles.map((file) => `- ${file}`).join("\n")
		}`;
		await this.createOrUpdateFile(filePath, content);
	}

	// --- File I/O Helpers ---

	private async createOrUpdateFile(
		filePath: string,
		content: string,
	): Promise<void> {
		await ensureParentDirectory(this.app.vault, filePath);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			await this.app.vault.create(filePath, content);
		}
	}

	private handleFileError(error: unknown, file: string): void {
		if (error instanceof Error) {
			if (error.name === "FileNotFoundError") {
				devError(`File not found: ${file}`);
				new Notice(`KOReader Importer: File not found: ${file}`);
			} else if (error.name === "MetadataParseError") {
				devError(`Error parsing metadata in ${file}:`, error.message);
				new Notice(
					`KOReader Importer: Error parsing metadata in ${file}. Check the console for details.`,
				);
			} else {
				devError(`Error processing file ${file}:`, error);
				new Notice(
					`KOReader Importer: Error processing file ${file}. Check the console for details.`,
				);
			}
		}
	}

	// --- File Name & Content Generation ---

	private generateFileName(docProps: DocProps): string {
		const normalizedAuthors = this.normalizeFileName(docProps.authors);
		const normalizedTitle = this.normalizeFileName(docProps.title);
		const authorsArray = normalizedAuthors.split(",").map((author) =>
			author.trim()
		);
		const authorsString = authorsArray.join(" & ") || "Unknown Author";
		const fileName = `${authorsString} - ${normalizedTitle}.md`;

		// Ensure file name is not too long (taking folder length into account)
		const maxFileNameLength = 260 - this.settings.highlightsFolder.length -
			1 - 4; // 4 for '.md'
		return fileName.length > maxFileNameLength
			? `${fileName.slice(0, maxFileNameLength)}.md`
			: fileName;
	}

	private generateFrontmatter(luaMetadata: LuaMetadata): string {
		const data = createFrontmatterData(
			luaMetadata,
			this.settings.frontmatter,
		);
		return formatFrontmatter(data);
	}

	private generateHighlightsContent(highlights: Annotation[]): string {
		highlights.sort((a, b) => {
			if (a.pageno !== b.pageno) return a.pageno - b.pageno;
			return new Date(a.datetime).getTime() -
				new Date(b.datetime).getTime();
		});
		return highlights.map(formatHighlight).join("");
	}

	private normalizeFileName(fileName: string): string {
		return fileName.replace(/[\\/:*?"<>|]/g, "_").trim();
	}

	private escapeYAMLString(str: string): string {
		return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	}

	// --- Cache Clearing (if needed externally) ---
	async clearCaches() {
		sdrFilesCache.clear();
		parsedMetadataCache.clear();
		devLog("Caches cleared.");
	}
}
