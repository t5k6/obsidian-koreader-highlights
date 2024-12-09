import { Notice, Plugin, TFile, type Vault } from "obsidian";
import {
	type Annotation,
	DEFAULT_SETTINGS,
	type DocProps,
	type KoReaderHighlightImporterSettings,
	type LuaMetadata,
} from "./types";
import { KoReaderSettingTab } from "./settings";
import { findSDRFiles, readSDRFileContent } from "./parser";
import { dirname, join as node_join, sep } from "node:path";

// Cache for findSDRFiles results
const sdrFilesCache: Map<string, string[]> = new Map();

// Cache for parsed metadata
const parsedMetadataCache: Map<string, LuaMetadata> = new Map();

export default class KoReaderHighlightImporter extends Plugin {
	settings: KoReaderHighlightImporterSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "import-koreader-highlights",
			name: "Import KoReader Highlights",
			callback: () => this.handleImportHighlights(),
		});

		this.addCommand({
			id: "scan-koreader-highlights",
			name: "Scan KoReader Highlights",
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
		console.log("Caches cleared.");
	}

	async handleImportHighlights() {
		if (!this.settings.koboMountPoint) {
			new Notice(
				"Please specify your KoReader mount point in the plugin settings.",
			);
			return;
		}

		try {
			await this.importHighlights();
		} catch (error) {
			console.error("Error importing highlights:", error);
			new Notice(
				"Error importing highlights. Check the console for details.",
			);
		}
	}

	async handleScanHighlightsDirectory() {
		if (!this.settings.koboMountPoint) {
			new Notice(
				"Please specify your KoReader mount point in the plugin settings.",
			);
			return;
		}

		try {
			await this.scanHighlightsDirectory();
		} catch (error) {
			console.error("Error scanning for highlights:", error);
			new Notice(
				"Error scanning for highlights. Check the console for details.",
			);
		}
	}

	async importHighlights() {
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
			new Notice(
				"No .sdr directories found at the specified mount point.",
			);
			return;
		}

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
						this.app,
					);
					parsedMetadataCache.set(file, luaMetadata);
				}

				if (!luaMetadata) {
					console.error(`No metadata found for file ${file}`);
					continue;
				}

				const highlights = luaMetadata.annotations || [];

				await this.saveHighlights(highlights, luaMetadata);
			} catch (error) {
				console.error(`Error processing file ${file}:`, error);
				new Notice(
					`Error processing file ${file}. Check the console for details.`,
				);
			}
		}

		new Notice("Highlights imported successfully!");
	}
	async saveHighlights(
		highlights: Annotation[],
		LuaMetadata: LuaMetadata,
	) {
		if (highlights.length === 0) {
			console.warn(
				"No highlights to save for:",
				LuaMetadata.docProps.title,
			);
			return;
		}

		const { vault } = this.app;
		const fileName = this.generateFileName(LuaMetadata.docProps);
		const filePath = node_join(this.settings.highlightsFolder, fileName);

		const frontmatter = this.generateFrontmatter(LuaMetadata);
		const content = frontmatter +
			this.generateHighlightsContent(highlights);

		try {
			await this.createOrUpdateFile(vault, filePath, content);
		} catch (error) {
			console.error(
				`Error saving highlights for ${LuaMetadata.docProps.title}:`,
				error,
			);
			new Notice(
				`Error saving highlights for ${LuaMetadata.docProps.title}. See console for details.`,
			);
		}
	}

	async scanHighlightsDirectory() {
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
			return;
		}

		try {
			await this.createOrUpdateNote(sdrFiles);
			new Notice("SDR directories listed in KoReader SDR Files.md");
		} catch (error) {
			console.error("Error updating SDR directories note:", error);
			new Notice(
				"Error updating SDR directories note. Check the console for details.",
			);
		}
	}

	async createOrUpdateNote(sdrFiles: string[]) {
		const vault = this.app.vault;
		const filePath = "KoReader SDR Files.md";
		const content = `# KoReader SDR Files\n\n${
			sdrFiles.map((file) => `- ${file}`).join("\n")
		}`;

		await this.createOrUpdateFile(vault, filePath, content);
	}

	async createOrUpdateFile(
		vault: Vault,
		filePath: string,
		content: string,
	) {
		const dirPath = dirname(filePath);
		const dirExists = await vault.adapter.exists(dirPath);

		if (!dirExists) {
			try {
				await vault.adapter.mkdir(dirPath);
			} catch (error) {
				console.error(`Error creating directory ${dirPath}:`, error);
				new Notice(
					`Error creating directory ${dirPath}. Check console for details.`,
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

	generateFrontmatter(LuaMetadata: LuaMetadata): string {
		let frontmatter = "---\n";
		const docProps = LuaMetadata.docProps;
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
		frontmatter += `pages: ${LuaMetadata.pages}\n`;
		frontmatter += "---\n\n";
		return frontmatter;
	}

	generateHighlightsContent(highlights: Annotation[]): string {
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
		const div = document.createElement("div");
		div.innerHTML = html;
		return div.textContent || div.innerText || "";
	}

	escapeYAMLString(str: string): string {
		return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	}
}
