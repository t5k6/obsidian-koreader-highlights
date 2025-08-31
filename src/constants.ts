export const DEFAULT_HIGHLIGHTS_FOLDER = "KOReader/Highlights";
export const DEFAULT_TEMPLATES_FOLDER = "KOReader/Templates";
export const DEFAULT_LOGS_FOLDER = "KOReader/Logs";

// Centralized database schema version for the index database
export const INDEX_DB_VERSION = 3;

// Shared UID key used in note frontmatter
export const KOHL_UID_KEY = "kohl-uid" as const;

/* ------------------------------------------------------------------ */
/*                              FILE SYSTEM                           */
/* ------------------------------------------------------------------ */

export const YIELD_INTERVAL = 250; // Files processed before yielding to event loop
export const FILENAME_UNIQUE_MAX_ATTEMPTS = 1000;
export const FILENAME_TRUNCATION_TARGET_LENGTH = 255;
export const FILENAME_UNIQUE_SUFFIX_RESERVE = " (999)".length; // Reserve space for " (999)"
export const FILENAME_TRUNCATION_HASH_LENGTH = 6;
