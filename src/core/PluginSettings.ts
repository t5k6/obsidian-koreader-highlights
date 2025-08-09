import type { Plugin } from "obsidian";
import {
	DEFAULT_HIGHLIGHTS_FOLDER,
	DEFAULT_LOGS_FOLDER,
	DEFAULT_TEMPLATES_FOLDER,
} from "src/constants";
import { FileSystemService } from "src/services/FileSystemService";
import {
	ensureBoolean,
	ensureNumber,
	ensureNumberInRange,
	ensureString,
	ensureStringArray,
} from "src/utils/validationUtils";
import type {
	CommentStyle,
	KoreaderHighlightImporterSettings,
	KoreaderTemplateSettings,
} from "../types";

/* ------------------------------------------------------------------ */
/*                   1.  DEFAULTS                         			  */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS: KoreaderHighlightImporterSettings = {
	koreaderMountPoint: "",
	excludedFolders: [
		".adds",
		".kobo",
		"$RECYCLE.BIN",
		"System Volume Information",
		".git",
		".obsidian",
		".stfolder",
		".stversions",
	],
	allowedFileTypes: ["epub", "pdf", "mobi", "cbz"],
	highlightsFolder: DEFAULT_HIGHLIGHTS_FOLDER,
	logToFile: false,
	logLevel: 1,
	logsFolder: DEFAULT_LOGS_FOLDER,
	enableFullDuplicateCheck: false,
	fileNameTemplate: "{{title}} - {{authors}}",
	useCustomFileNameTemplate: false,
	autoMergeOnAddition: true,
	frontmatter: {
		disabledFields: [],
		customFields: [],
		useUnknownAuthor: false,
	},
	maxHighlightGap: 5,
	maxTimeGapMinutes: 10,
	mergeOverlappingHighlights: true,
	template: {
		useCustomTemplate: false,
		source: "vault",
		selectedTemplate: "default",
		templateDir: DEFAULT_TEMPLATES_FOLDER,
	},
	commentStyle: "html",
	backupRetentionDays: 30,
	scanTimeoutSeconds: 8,
};

/* ------------------------------------------------------------------ */
/*                      3.  MAIN CLASS                                 */
/* ------------------------------------------------------------------ */

export class PluginSettings {
	private readonly SCOPE = "PluginSettings";

	constructor(private plugin: Plugin) {}

	/**
	 * Normalize a possibly unknown string value into a vault path,
	 * falling back to the provided default value.
	 */
	private toVaultPathOrDefault(value: unknown, defaultValue: string): string {
		const s = ensureString(value, defaultValue);
		return FileSystemService.toVaultPath(s || defaultValue);
	}

	public async loadSettings(): Promise<KoreaderHighlightImporterSettings> {
		const raw: Partial<KoreaderHighlightImporterSettings> =
			(await this.plugin.loadData()) ?? {};

		const settings: KoreaderHighlightImporterSettings =
			structuredClone(DEFAULT_SETTINGS);

		// Primitives
		const rawMountPoint = ensureString(
			raw.koreaderMountPoint,
			DEFAULT_SETTINGS.koreaderMountPoint,
		);
		// Normalize the path to use forward slashes and remove any trailing slash
		settings.koreaderMountPoint =
			FileSystemService.normalizeSystemPath(rawMountPoint);

		settings.logToFile = ensureBoolean(
			raw.logToFile,
			DEFAULT_SETTINGS.logToFile,
		);
		settings.enableFullDuplicateCheck = ensureBoolean(
			raw.enableFullDuplicateCheck,
			DEFAULT_SETTINGS.enableFullDuplicateCheck,
		);
		settings.autoMergeOnAddition = ensureBoolean(
			raw.autoMergeOnAddition,
			DEFAULT_SETTINGS.autoMergeOnAddition,
		);
		settings.useCustomFileNameTemplate = ensureBoolean(
			raw.useCustomFileNameTemplate,
			DEFAULT_SETTINGS.useCustomFileNameTemplate,
		);
		settings.fileNameTemplate = ensureString(
			raw.fileNameTemplate,
			DEFAULT_SETTINGS.fileNameTemplate,
		);

		// Number with range validation
		settings.logLevel = ensureNumberInRange(
			raw.logLevel,
			DEFAULT_SETTINGS.logLevel,
			[0, 1, 2, 3],
		) as KoreaderHighlightImporterSettings["logLevel"];

		// Sanitized path
		settings.highlightsFolder = this.toVaultPathOrDefault(
			raw.highlightsFolder,
			DEFAULT_HIGHLIGHTS_FOLDER,
		);

		// Arrays
		settings.excludedFolders = ensureStringArray(
			raw.excludedFolders,
			DEFAULT_SETTINGS.excludedFolders,
		);
		settings.allowedFileTypes = ensureStringArray(
			raw.allowedFileTypes,
			DEFAULT_SETTINGS.allowedFileTypes,
		).map((s) => s.toLowerCase());

		// Nested Objects
		if (typeof raw.frontmatter === "object" && raw.frontmatter !== null) {
			settings.frontmatter.useUnknownAuthor = ensureBoolean(
				raw.frontmatter.useUnknownAuthor,
				DEFAULT_SETTINGS.frontmatter.useUnknownAuthor,
			);
			settings.frontmatter.disabledFields = ensureStringArray(
				raw.frontmatter.disabledFields,
				DEFAULT_SETTINGS.frontmatter.disabledFields,
			);
			settings.frontmatter.customFields = ensureStringArray(
				raw.frontmatter.customFields,
				DEFAULT_SETTINGS.frontmatter.customFields,
			);
		}

		// --- Nested Objects (Example: Template) ---
		if (typeof raw.template === "object" && raw.template !== null) {
			const tmp = raw.template as Partial<KoreaderTemplateSettings>;
			settings.template.useCustomTemplate = ensureBoolean(
				tmp.useCustomTemplate,
				DEFAULT_SETTINGS.template.useCustomTemplate,
			);
			settings.template.selectedTemplate = ensureString(
				tmp.selectedTemplate,
				DEFAULT_SETTINGS.template.selectedTemplate,
			);
			const source = ensureString(tmp.source, DEFAULT_SETTINGS.template.source);
			settings.template.source = ["vault", "external"].includes(source)
				? source
				: DEFAULT_SETTINGS.template.source;

			// Optional template directory normalization (if present)
			if (typeof tmp.templateDir === "string") {
				settings.template.templateDir = this.toVaultPathOrDefault(
					tmp.templateDir,
					DEFAULT_SETTINGS.template.templateDir,
				);
			}
		}

		const commentStyle = ensureString(
			raw.commentStyle,
			DEFAULT_SETTINGS.commentStyle,
		);
		settings.commentStyle = (
			["html", "md", "none"].includes(commentStyle)
				? commentStyle
				: DEFAULT_SETTINGS.commentStyle
		) as CommentStyle;

		settings.backupRetentionDays = Math.max(
			0, // Ensure it's not negative
			ensureNumber(
				raw.backupRetentionDays,
				DEFAULT_SETTINGS.backupRetentionDays,
			),
		);

		// Scan timeout (seconds) with sane floor of 1s
		settings.scanTimeoutSeconds = Math.max(
			1,
			ensureNumber(raw.scanTimeoutSeconds, DEFAULT_SETTINGS.scanTimeoutSeconds),
		);

		return settings;
	}

	/* ------------------------------ save ---------------------------- */

	public async saveSettings(
		settings: KoreaderHighlightImporterSettings,
	): Promise<void> {
		await this.plugin.saveData(settings);
	}
}
