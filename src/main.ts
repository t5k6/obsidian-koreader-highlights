import {
	normalizePath,
	Notice,
	Plugin,
	sanitizeHTMLToDom,
	TFile,
	type Vault,
} from "obsidian";
import { sep } from "node:path";
import {
	type Annotation,
	DEFAULT_SETTINGS,
	type DocProps,
	type DuplicateChoice,
	type KoReaderHighlightImporterSettings,
	type LuaMetadata,
} from "./types";
import { KoReaderSettingTab } from "./settings";
import { findSDRFiles, readSDRFileContent } from "./parser";
import {
	devError,
	devLog,
	getFileNameWithoutExt,
	handleDirectoryError,
	initLogging,
	setDebugMode,
} from "./utils";
import { DuplicateHandler } from "./duplicateHandler";
import { DuplicateHandlingModal } from "./duplicateModal";
import { stat } from "node:fs/promises";

// Cache for findSDRFiles results
const sdrFilesCache: Map<string, string[]> = new Map();

// Cache for parsed metadata
const parsedMetadataCache: Map<string, LuaMetadata> = new Map();

export default class KoReaderHighlightImporter extends Plugin {
	settings: KoReaderHighlightImporterSettings = DEFAULT_SETTINGS;
	duplicateHandler!: DuplicateHandler;

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
			const e = error as NodeJS.ErrnoException;
			handleDirectoryError(this.settings.koboMountPoint, e);
			new Notice(
				"KOReader Importer: Please check the mount point in the plugin settings.",
			);
			return false;
		}
	}

	async onload() {
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

	async clearCaches() {
		sdrFilesCache.clear();
		parsedMetadataCache.clear();
		devLog("Caches cleared.");
	}

	async handleImportHighlights() {
		if (!await this.checkMountPoint()) return;

		try {
			await this.importHighlights();
		} catch (error) {
			devError(
				"Error importing highlights:",
				error,
			);
			new Notice(
				"KOReader Importer: Error importing highlights. Check the console for details.",
			);
		}
	}
	async handleScanHighlightsDirectory() {
		if (!await this.checkMountPoint()) return;

		try {
			await this.scanHighlightsDirectory();
		} catch (error) {
			devError(
				"Error scanning for highlights:",
				error,
			);
			new Notice(
				"KOReader Importer: Error scanning for highlights. Check the console for details.",
			);
		}
	}

	async importHighlights() {
		if (!await this.checkMountPoint()) {
			return;
		}
		const sdrFiles = await this.ensureMountPointAndSDRFiles();
		if (!sdrFiles) return;

		for (const file of sdrFiles) {
			try {
				let luaMetadata: LuaMetadata | undefined = parsedMetadataCache
					.get(file);
				if (!luaMetadata) {
					// If no allowed file types are specified, pass an empty array to readSDRFileContent
					// to indicate that any metadata file should be considered.
					console.log(
						"allowedFileTypes",
						this.settings.allowedFileTypes,
						this.settings.allowedFileTypes.length,
					);
					const isFileTypeFilterEmpty = this.settings.allowedFileTypes
						.every((type) => type.trim() === "");

					luaMetadata = await readSDRFileContent(
						file,
						isFileTypeFilterEmpty
							? []
							: this.settings.allowedFileTypes,
					);
					parsedMetadataCache.set(file, luaMetadata);
					devLog(`No metadata found for file ${file}`);
				}

				const highlights = luaMetadata.annotations || [];

				// Use file name as title if both author and title are missing
				if (
					luaMetadata.docProps.authors === "" &&
					luaMetadata.docProps.title === ""
				) {
					luaMetadata.docProps.authors = getFileNameWithoutExt(file);
				}
				devLog(
					`Highlights imported successfully!, for ${luaMetadata.docProps.title} from ${luaMetadata.docProps.authors}`,
				);
				await this.saveHighlights(highlights, luaMetadata);
			} catch (error) {
				if (
					error instanceof Error && error.name === "FileNotFoundError"
				) {
					devError(`File not found: ${file}`);
					new Notice(`KOReader Importer: File not found: ${file}`);
				} else if (
					error instanceof Error &&
					error.name === "MetadataParseError"
				) {
					devError(
						`Error parsing metadata in ${file}:`,
						error.message,
					);
					new Notice(
						`KOReader Importer: Error parsing metadata in ${file}. Check the console for details.`,
					);
				} else {
					devError(
						`Error processing file ${file}:`,
						error,
					);
					new Notice(
						`KOReader Importer: Error processing file ${file}. Check the console for details.`,
					);
				}
			}
		}
		new Notice("KOReader Importer: Highlights imported successfully!");
	}
	async saveHighlights(
		highlights: Annotation[],
		luaMetadata: LuaMetadata,
	): Promise<void> {
		if (highlights.length === 0) {
			return;
		}

		const { vault } = this.app;
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
				// Check for potential duplicates
				const potentialDuplicates = await this.duplicateHandler
					.findPotentialDuplicates(
						luaMetadata.docProps,
					);
				if (potentialDuplicates.length > 0) {
					// Step 1: Analyze all duplicates in parallel
					const analysisPromises = potentialDuplicates.map(
						async (duplicate) => {
							return await this.duplicateHandler.analyzeDuplicate(
								duplicate,
								highlights,
								luaMetadata,
							);
						},
					);
					const analyses = await Promise.all(analysisPromises);

					// Step 2: Handle duplicates sequentially
					let applyToAll = false;
					let applyToAllChoice: DuplicateChoice | null = null;

					for (const analysis of analyses) {
						if (applyToAll && applyToAllChoice !== null) {
							// Apply the previously chosen action to all remaining duplicates
							const { choice } = await this.duplicateHandler
								.handleDuplicate(
									analysis,
									content,
								);
							if (choice !== "skip") fileCreated = true;
							continue;
						}

						// Prompt the user for a choice
						this.duplicateHandler.currentMatch = analysis;
						const { choice, applyToAll: userChoseApplyToAll } =
							await this.duplicateHandler.handleDuplicate(
								analysis,
								content,
							);

						if (choice !== "skip") fileCreated = true;

						if (userChoseApplyToAll) {
							applyToAll = true;
							applyToAllChoice = choice;
						}

						if (choice === "skip") {
						}
					}
				}

				// If no duplicates were found or handled, create new file
				if (!fileCreated && potentialDuplicates.length === 0) {
					await this.createOrUpdateFile(vault, filePath, content);
				}
			} else {
				// If enableFullDuplicateCheck is disabled, just create new file
				await this.createOrUpdateFile(vault, filePath, content);
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
	async scanHighlightsDirectory(): Promise<void> {
		const sdrFiles = await this.ensureMountPointAndSDRFiles();
		if (!sdrFiles || !Array.isArray(sdrFiles)) return;

		try {
			await this.createOrUpdateNote(sdrFiles);
			new Notice("SDR directories listed in KoReader SDR Files.md");
		} catch (error) {
			devError(
				"Error updating SDR directories note:",
				error,
			);
			new Notice(
				"KOReader Importer: Error updating SDR directories note. Check the console for details.",
			);
		}
	}
	async createOrUpdateNote(sdrFiles: string[]): Promise<void> {
		const vault = this.app.vault;
		const filePath = normalizePath("KoReader SDR Files.md");
		const content = `# KoReader SDR Files\n\n${
			sdrFiles.map((file) => `- ${file}`).join("\n")
		}`;

		await this.createOrUpdateFile(vault, filePath, content);
	}

	async createOrUpdateFile(
		vault: Vault,
		filePath: string,
		content: string,
	): Promise<void> {
		const dirPath = normalizePath(
			filePath.substring(0, filePath.lastIndexOf("/")),
		);
		const dirExists = vault.getFolderByPath(dirPath);

		if (!dirExists) {
			try {
				await vault.createFolder(dirPath);
			} catch (error) {
				devError(
					`Error creating folder ${dirPath}:`,
					error,
				);
				new Notice(
					`KOReader Importer: Error creating directory ${dirPath}. Check console for details.`,
				);
				return;
			}
		}

		const file = vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			await vault.modify(file, content);
		} else {
			await vault.create(filePath, content);
		}
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

		if (!Array.isArray(this.settings.excludedFolders)) {
			new Notice(
				"KOReader Importer: Excluded folders setting should be an array.",
			);
			this.settings.excludedFolders = [];
		}
		if (!Array.isArray(this.settings.allowedFileTypes)) {
			new Notice(
				"KOReader Importer: Allowed file types setting should be an array",
			);
			this.settings.allowedFileTypes = [];
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getCacheKey(
		rootDir: string,
		excludedFolders: string[],
		allowedFileTypes: string[],
	): string {
		return `${rootDir}:${excludedFolders.join(",")}:${
			allowedFileTypes.join(
				",",
			)
		}`;
	}

	// Helper functions for file name, frontmatter, and content generation
	async ensureMountPointAndSDRFiles() {
		if (!await this.checkMountPoint()) return [];

		const cacheKey = this.getCacheKey(
			this.settings.koboMountPoint,
			this.settings.excludedFolders,
			this.settings.allowedFileTypes,
		);

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

	generateFileName(docProps: DocProps): string {
		const normalizedAuthors = this.normalizeFileName(docProps.authors);
		const normalizedTitle = this.normalizeFileName(docProps.title);
		const authorsArray = normalizedAuthors.split(",").map((author) =>
			author.trim()
		);
		const authorsString = authorsArray.join(" & ") || "Unknown Author";
		const fileName = `${authorsString} - ${normalizedTitle}.md`;

		const maxFileNameLength = 260 -
			this.settings.highlightsFolder.length - sep.length - 4; // 4 for '.md'
		return fileName.length > maxFileNameLength
			? `${fileName.slice(0, maxFileNameLength)}.md`
			: fileName;
	}

	generateFrontmatter(luaMetadata: LuaMetadata): string {
		let frontmatter = "---\n";
		const docProps = luaMetadata.docProps;
		for (const key in docProps) {
			if (
				Object.prototype.hasOwnProperty.call(docProps, key) &&
				docProps[key as keyof DocProps] !== ""
			) {
				let value = docProps[key as keyof DocProps];
				if (key === "description") {
					value = sanitizeHTMLToDom(value as string).textContent ||
						"";
				}
				if (key === "authors") {
					value = `[[${value}]]`;
				}
				frontmatter += `${key}: "${
					this.escapeYAMLString(value as string)
				}"\n`;
			}
		}
		frontmatter += `pages: ${luaMetadata.pages}\n`;
		frontmatter += "---\n\n";
		return frontmatter;
	}
	generateHighlightsContent(highlights: Annotation[]): string {
		highlights.sort((a, b) => {
			// First sort by page number
			if (a.pageno !== b.pageno) {
				return a.pageno - b.pageno;
			}

			// If same page, sort by datetime
			const dateA = new Date(a.datetime);
			const dateB = new Date(b.datetime);
			return dateA.getTime() - dateB.getTime();
		});
		return highlights
			.map(
				(highlight) =>
					`### Chapter: ${highlight.chapter}\n(*Date: ${highlight.datetime} - Page: ${highlight.pageno}*)\n\n${highlight.text}\n\n---\n`,
			)
			.join("");
	}

	normalizeFileName(fileName: string): string {
		return fileName.replace(/[\\/:*?"<>|]/g, "_").trim();
	}

	escapeYAMLString(str: string): string {
		return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	}
}
