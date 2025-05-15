import type { Plugin } from "obsidian";
import type {
    FrontmatterSettings,
    KoReaderHighlightImporterSettings,
    KoReaderTemplateSettings,
} from "../types";
import { devError, devLog, devWarn } from "../utils/logging";

export const DEFAULT_SETTINGS: KoReaderHighlightImporterSettings = {
    koboMountPoint: "",
    excludedFolders: [
        ".adds",
        ".kobo",
        "$RECYCLE.BIN",
        "System Volume Information",
        ".git",
        ".obsidian",
        ".stfolder",
    ],
    allowedFileTypes: ["epub", "pdf", "mobi", "cbz"],
    highlightsFolder: "KoReader Highlights",
    debugMode: false,
    debugLevel: 3,
    enableFullDuplicateCheck: false,
    frontmatter: {
        disabledFields: [],
        customFields: [],
    },
    maxHighlightGap: 5,
    maxTimeGapMinutes: 10,
    mergeOverlappingHighlights: true,
    template: {
        useCustomTemplate: false,
        source: "vault",
        selectedTemplate: "default",
    },
};

export class PluginSettings {
    constructor(private plugin: Plugin) {}

    async loadSettings(): Promise<KoReaderHighlightImporterSettings> {
        devLog("Loading KoReader Importer settings...");
        const loadedData = (await this.plugin.loadData()) as
            | Partial<KoReaderHighlightImporterSettings>
            | null ?? {};
        devLog("Raw loaded data from vault:", loadedData);

        const settings: KoReaderHighlightImporterSettings = {
            ...DEFAULT_SETTINGS,
            ...loadedData,
            frontmatter: {
                ...DEFAULT_SETTINGS.frontmatter,
                ...(loadedData.frontmatter ?? {}),
            },
            template: {
                ...DEFAULT_SETTINGS.template,
                ...(loadedData.template ?? {}),
            },
        };

        // --- Validation and Correction ---
        settings.koboMountPoint = typeof settings.koboMountPoint === "string"
            ? settings.koboMountPoint
            : DEFAULT_SETTINGS.koboMountPoint;
        settings.highlightsFolder =
            typeof settings.highlightsFolder === "string"
                ? settings.highlightsFolder
                : DEFAULT_SETTINGS.highlightsFolder;
        settings.debugMode = typeof settings.debugMode === "boolean"
            ? settings.debugMode
            : DEFAULT_SETTINGS.debugMode;
        settings.enableFullDuplicateCheck =
            typeof settings.enableFullDuplicateCheck === "boolean"
                ? settings.enableFullDuplicateCheck
                : DEFAULT_SETTINGS.enableFullDuplicateCheck;

        // Validate array types and their contents
        const validateStringArray = (
            arr: unknown,
            defaultArr: string[],
        ): string[] => {
            if (
                !Array.isArray(arr) ||
                !arr.every((item) => typeof item === "string")
            ) {
                devWarn(
                    "Correcting invalid string array setting. Resetting to default.",
                );
                return [...defaultArr]; // Return a clone of the default
            }
            return arr.map((item) => item.trim()).filter(Boolean); // Trim and filter empty strings
        };
        settings.excludedFolders = validateStringArray(
            settings.excludedFolders,
            DEFAULT_SETTINGS.excludedFolders,
        );
        settings.allowedFileTypes = validateStringArray(
            settings.allowedFileTypes,
            DEFAULT_SETTINGS.allowedFileTypes,
        )
            .map((type) => type.toLowerCase()); // Ensure lowercase

        // Validate frontmatter structure and its arrays
        if (
            typeof settings.frontmatter !== "object" ||
            settings.frontmatter === null
        ) {
            devWarn(
                "Correcting invalid 'frontmatter' setting (expected object). Resetting to default.",
            );
            settings.frontmatter = { ...DEFAULT_SETTINGS.frontmatter };
        } else {
            const fm = settings.frontmatter as FrontmatterSettings; // Assert type for easier access
            fm.disabledFields = validateStringArray(
                fm.disabledFields,
                DEFAULT_SETTINGS.frontmatter.disabledFields,
            );
            fm.customFields = validateStringArray(
                fm.customFields,
                DEFAULT_SETTINGS.frontmatter.customFields,
            );
        }

        // Validate template structure
        if (
            typeof settings.template !== "object" || settings.template === null
        ) {
            devWarn(
                "Correcting invalid 'template' setting (expected object). Resetting to default.",
            );
            settings.template = { ...DEFAULT_SETTINGS.template };
        } else {
            const tmpl = settings.template as KoReaderTemplateSettings; // Type assertion
            tmpl.useCustomTemplate = typeof tmpl.useCustomTemplate === "boolean"
                ? tmpl.useCustomTemplate
                : DEFAULT_SETTINGS.template.useCustomTemplate;
            tmpl.source = typeof tmpl.source === "string" &&
                    ["vault", "external"].includes(tmpl.source)
                ? tmpl.source
                : DEFAULT_SETTINGS.template.source;
            tmpl.selectedTemplate = typeof tmpl.selectedTemplate === "string"
                ? tmpl.selectedTemplate.trim()
                : DEFAULT_SETTINGS.template.selectedTemplate;
        }

        // Validate debugLevel (ensure it's one of the defined levels)
        const validLevels = [0, 1, 2, 3];
        if (
            typeof settings.debugLevel !== "number" ||
            !validLevels.includes(settings.debugLevel as 0 | 1 | 2 | 3)
        ) {
            devWarn(
                `Correcting invalid 'debugLevel' (${settings.debugLevel}). Resetting to default (${DEFAULT_SETTINGS.debugLevel}).`,
            );
            settings.debugLevel = DEFAULT_SETTINGS.debugLevel;
        }

        // Validate number types for highlight processing settings (ensure non-negative)
        const validateNonNegativeNumber = (
            num: unknown,
            defaultNum: number,
        ): number => {
            if (typeof num === "number" && Number.isFinite(num) && num >= 0) {
                return num;
            }
            devWarn(
                `Correcting invalid number setting (${num}). Resetting to default (${defaultNum}).`,
            );
            return defaultNum;
        };
        settings.maxHighlightGap = validateNonNegativeNumber(
            settings.maxHighlightGap,
            DEFAULT_SETTINGS.maxHighlightGap,
        );
        settings.maxTimeGapMinutes = validateNonNegativeNumber(
            settings.maxTimeGapMinutes,
            DEFAULT_SETTINGS.maxTimeGapMinutes,
        );
        settings.mergeOverlappingHighlights =
            typeof settings.mergeOverlappingHighlights === "boolean"
                ? settings.mergeOverlappingHighlights
                : DEFAULT_SETTINGS.mergeOverlappingHighlights;

        devLog("Settings loaded and validated:", settings);
        return settings;
    }

    async saveSettings(
        settings: KoReaderHighlightImporterSettings,
    ): Promise<void> {
        devLog("Saving KoReader Importer settings...");
        try {
            await this.plugin.saveData(settings);
            devLog("Settings saved successfully.");
        } catch (error) {
            devError("Failed to save settings:", error);
        }
    }
}
