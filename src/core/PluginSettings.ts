import type { Plugin } from "obsidian";
import {
  DEFAULT_HIGHLIGHTS_FOLDER,
  DEFAULT_TEMPLATES_FOLDER,
  DEFAULT_LOGS_FOLDER,
} from "src/constants";
import { toVaultRelPath } from "src/utils/fileUtils";
import { logger } from "src/utils/logging";
import {
  ensureBoolean,
  ensureNumberInRange,
  ensureString,
  ensureStringArray,
} from "src/utils/validationUtils";
import type {
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
};

/* ------------------------------------------------------------------ */
/*                   2.  SCHEMA 						              */
/* ------------------------------------------------------------------ */

type Primitive = string | number | boolean;

interface FieldRule<T = Primitive> {
  key: keyof KoreaderHighlightImporterSettings;
  type: "string" | "number" | "boolean";
  default: T;
  normalize?: (v: any) => T;
  validate?: (v: any) => boolean;
}

const FIELD_RULES: FieldRule[] = [
  {
    key: "koreaderMountPoint",
    type: "string",
    default: DEFAULT_SETTINGS.koreaderMountPoint,
  },
  {
    key: "highlightsFolder",
    type: "string",
    default: DEFAULT_SETTINGS.highlightsFolder,
  },
  { key: "logToFile", type: "boolean", default: DEFAULT_SETTINGS.logToFile },
  {
    key: "logLevel",
    type: "number",
    default: DEFAULT_SETTINGS.logLevel,
    validate: (v) => [0, 1, 2, 3].includes(v),
  },
  {
    key: "enableFullDuplicateCheck",
    type: "boolean",
    default: DEFAULT_SETTINGS.enableFullDuplicateCheck,
  },
  {
    key: "autoMergeOnAddition",
    type: "boolean",
    default: DEFAULT_SETTINGS.autoMergeOnAddition,
  },
  {
    key: "maxHighlightGap",
    type: "number",
    default: DEFAULT_SETTINGS.maxHighlightGap,
    validate: (v) => typeof v === "number" && v >= 0,
  },
  {
    key: "maxTimeGapMinutes",
    type: "number",
    default: DEFAULT_SETTINGS.maxTimeGapMinutes,
    validate: (v) => typeof v === "number" && v >= 0,
  },
  {
    key: "mergeOverlappingHighlights",
    type: "boolean",
    default: DEFAULT_SETTINGS.mergeOverlappingHighlights,
  },
];

/* ------------------------------------------------------------------ */
/*                      3.  MAIN CLASS                                 */
/* ------------------------------------------------------------------ */

export class PluginSettings {
  constructor(private plugin: Plugin) {}

  public async loadSettings(): Promise<KoreaderHighlightImporterSettings> {
    logger.info("PluginSettings: Loading KOReader Importer settings…");
    const raw: Partial<KoreaderHighlightImporterSettings> =
      (await this.plugin.loadData()) ?? {};

    const settings: KoreaderHighlightImporterSettings =
      structuredClone(DEFAULT_SETTINGS);

    // Primitives
    settings.koreaderMountPoint = ensureString(
      raw.koreaderMountPoint,
      DEFAULT_SETTINGS.koreaderMountPoint,
    );
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

    // Number with range validation
    settings.logLevel = ensureNumberInRange(
      raw.logLevel,
      DEFAULT_SETTINGS.logLevel,
      [0, 1, 2, 3],
    ) as KoreaderHighlightImporterSettings["logLevel"];

    // Sanitized path
    const folder = ensureString(
      raw.highlightsFolder,
      DEFAULT_HIGHLIGHTS_FOLDER,
    );
    settings.highlightsFolder = toVaultRelPath(
      folder || DEFAULT_HIGHLIGHTS_FOLDER,
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
    }

    logger.info("PluginSettings: Settings validated:", settings);
    return settings;
  }

  /* ------------------------------ save ---------------------------- */

  public async saveSettings(
    settings: KoreaderHighlightImporterSettings,
  ): Promise<void> {
    try {
      await this.plugin.saveData(settings);
      logger.info("PluginSettings: KOReader Importer settings saved.");
    } catch (e) {
      logger.error("PluginSettings: Failed to save settings", e);
    }
  }
}
