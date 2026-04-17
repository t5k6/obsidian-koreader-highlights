import { sha1Hex } from "src/lib/core/crypto";

const BACKUP_FILENAME_RE_NEW =
  /^(?<safeBase>.+)-(?<uid>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(?<pathHash>[a-f0-9]{8})-(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z?)\.md$/i;

const BACKUP_FILENAME_RE_LEGACY =
  /^(?<safeBase>.+)-(?<pathHash>[a-f0-9]{8})-(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z?)\.md$/i;

export interface ParsedBackupFilename {
  safeBase: string;
  pathHash: string;
  uid: string | null;
  timestamp: Date;
  format: "new" | "legacy";
}

export function getBackupPathHash(filePath: string): string {
  return sha1Hex(filePath).slice(0, 8);
}

export function parseBackupTimestamp(timestamp: string): Date | null {
  const isoString = timestamp.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?(Z)?$/,
    (_full, date, hours, minutes, seconds, millis, zulu) =>
      `${date}T${hours}:${minutes}:${seconds}${millis ? `.${millis}` : ""}${zulu ?? ""}`,
  );

  const parsed = new Date(isoString);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseBackupFilename(filename: string): ParsedBackupFilename | null {
  const newMatch = BACKUP_FILENAME_RE_NEW.exec(filename);
  const newGroups = newMatch?.groups;

  if (newGroups) {
    const timestamp = parseBackupTimestamp(newGroups.timestamp);
    if (!timestamp) {
      return null;
    }

    return {
      safeBase: newGroups.safeBase,
      pathHash: newGroups.pathHash,
      uid: newGroups.uid,
      timestamp,
      format: "new",
    };
  }

  const legacyMatch = BACKUP_FILENAME_RE_LEGACY.exec(filename);
  const legacyGroups = legacyMatch?.groups;

  if (!legacyGroups) {
    return null;
  }

  const timestamp = parseBackupTimestamp(legacyGroups.timestamp);
  if (!timestamp) {
    return null;
  }

  return {
    safeBase: legacyGroups.safeBase,
    pathHash: legacyGroups.pathHash,
    uid: null,
    timestamp,
    format: "legacy",
  };
}

export function backupGroupKey(parsed: ParsedBackupFilename): string {
  return parsed.uid ?? `pathhash:${parsed.pathHash}`;
}
