import { normalizePath, Notice, Plugin, TFile, type Vault } from "obsidian";
import { sep } from "node:path";
import {
	type Annotation,
	DEFAULT_SETTINGS,
	type DocProps,
	type KoReaderHighlightImporterSettings,
	type LuaMetadata,
} from "./types";
import { KoReaderSettingTab } from "./settings";
import { findSDRFiles, readSDRFileContent } from "./parser";
import { devError, devLog, devWarn, setDebugMode } from "./utils";

// Cache for findSDRFiles results
const sdrFilesCache: Map<string, string[]> = new Map();

// Cache for parsed metadata
const parsedMetadataCache: Map<string, LuaMetadata> = new Map();

export default class KoReaderHighlightImporter extends Plugin {
	settings: KoReaderHighlightImporterSettings = DEFAULT_SETTINGS;

	private checkMountPoint(): boolean {
		if (!this.settings.koboMountPoint) {
			new Notice(
				"KOReader Importer: Please specify your KoReader mount point in the plugin settings.",
			);
			return false;
		}
		return true;
	}

	async onload() {
		await this.loadSettings();
		setDebugMode(this.settings.debugMode);

		this.addCommand({
			id: "import-koreader-highlights",
			name: "Import KoReader highlights",
			callback: () => this.handleImportHighlights(),
		});

		this.addCommand({
			id: "scan-koreader-highlights",
			name: "Scan KoReader highlights",
			callback: () => this.handleScanHighlightsDirectory(),
		});

		this.addSettingTab(new KoReaderSettingTab(this.app, this));
	}

	onunload() {
		// Clear caches on unload
		sdrFilesCache.clear();
		parsedMetadataCache.clear();
	}

	async clearCaches() {
		sdrFilesCache.clear();
		parsedMetadataCache.clear();
		devLog("Caches cleared.");
	}

	async handleImportHighlights() {
		if (!this.checkMountPoint()) return;

		try {
			await this.importHighlights();
		} catch (error) {
			devError(
				"Error importing highlights:",
				error instanceof Error ? error.message : String(error),
			);
			new Notice(
				"KOReader Importer: Error importing highlights. Check the console for details.",
			);
		}
	}
	async handleScanHighlightsDirectory() {
		if (!this.checkMountPoint()) return;

		try {
			await this.scanHighlightsDirectory();
		} catch (error) {
			devError(
				"Error scanning for highlights:",
				error instanceof Error ? error.message : String(error),
			);
			new Notice(
				"KOReader Importer: Error scanning for highlights. Check the console for details.",
			);
		}
	}

	async importHighlights() {
		const sdrFiles = await this.ensureMountPointAndSDRFiles();
		if (!sdrFiles) return;

		for (const file of sdrFiles) {
			try {
				let luaMetadata: LuaMetadata | undefined = parsedMetadataCache
					.get(file);
				if (!luaMetadata) {
					// If no allowed file types are specified, pass an empty array to readSDRFileContent
					// to indicate that any metadata file should be considered.
					const isFileTypeFilterEmpty =
						this.settings.allowedFileTypes.length === 0 ||
						(this.settings.allowedFileTypes.length === 1 &&
							this.settings.allowedFileTypes[0] === "");
					luaMetadata = await readSDRFileContent(
						file,
						isFileTypeFilterEmpty
							? []
							: this.settings.allowedFileTypes,
					);
					parsedMetadataCache.set(file, luaMetadata);
				}

				if (!luaMetadata) {
					devError(`No metadata found for file ${file}`);
					continue;
				}

				const highlights = luaMetadata.annotations || [];

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
						error instanceof Error ? error.message : String(error),
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
			devWarn(
				"No highlights to save for:",
				luaMetadata.docProps.title,
			);
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
			await this.createOrUpdateFile(vault, filePath, content);
		} catch (error) {
			devError(
				`Error saving highlights for ${luaMetadata.docProps.title}:`,
				error instanceof Error ? error.message : String(error),
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
				error instanceof Error ? error.message : String(error),
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
					error instanceof Error ? error.message : String(error),
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
		if (!this.checkMountPoint()) return;

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
			return null;
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
					value = this.sanitizeHTML(value as string);
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
		highlights.sort((a, b) => a.pageno - b.pageno);
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

	sanitizeHTML(html: string): string {
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, "text/html");
		return doc.body.textContent || "";
	}

	escapeYAMLString(str: string): string {
		return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	}
}
