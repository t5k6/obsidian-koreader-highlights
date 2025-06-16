import type { Dir } from "node:fs";
import { access, opendir, readFile, stat as fsStat } from "node:fs/promises";
import { platform } from "node:os";
import { join as joinPath } from "node:path";
import { Notice } from "obsidian";
import type { KoReaderHighlightImporterSettings } from "../types";

import { handleFileSystemError } from "../utils/fileUtils";
import { devLog, devWarn } from "../utils/logging";

const SDR_SUFFIX = ".sdr";
const METADATA_REGEX = /^metadata\.(.+)\.lua$/i;
const MAX_PARALLEL_IO = 64;

function limit(capacity = MAX_PARALLEL_IO) {
  let active = 0;
  const queue: (() => void)[] = [];

  return async function <T>(task: () => Promise<T>): Promise<T> { // generic here
    if (active >= capacity) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      if (queue.length) queue.shift()!();
    }
  };
}
const io = limit();

export class SDRFinder {
  private sdrDirCache = new Map<string, Promise<string[]>>();
  private metadataNameCache = new Map<string, string | null>();
  private cacheKey: string | null = null;

  constructor(private settings: KoReaderHighlightImporterSettings) {
    this.updateCacheKey();
  }

  updateSettings(next: KoReaderHighlightImporterSettings): void {
    const prevKey = this.cacheKey;
    this.settings = next;
    this.updateCacheKey();
    if (this.cacheKey !== prevKey) this.clearCache();
  }

  async *iterSdrDirectories(): AsyncGenerator<string> {
    const all = await this.findSdrDirectoriesWithMetadata();
    for (const path of all) yield path;
  }

  async findSdrDirectoriesWithMetadata(): Promise<string[]> {
    if (!this.cacheKey) return [];

    let inFlight = this.sdrDirCache.get(this.cacheKey);
    if (!inFlight) {
      inFlight = this.scan();
      this.sdrDirCache.set(this.cacheKey, inFlight);
    }
    return inFlight;
  }

  async readMetadataFileContent(sdrDir: string): Promise<string | null> {
    const name = await this.getMetadataFileName(sdrDir);
    if (!name) return null;

    const full = joinPath(sdrDir, name);
    try {
      devLog("Reading metadata:", full);
      return await readFile(full, "utf-8");
    } catch (err) {
      handleFileSystemError("reading metadata file", full, err, {
        shouldThrow: false,
      });
      return null;
    }
  }

  clearCache(): void {
    this.sdrDirCache.clear();
    this.metadataNameCache.clear();
    devLog("SDRFinder: caches cleared");
  }

  private updateCacheKey(): void {
    this.cacheKey = `${this.settings.koboMountPoint ?? "nokey"}::` +
      `${this.settings.excludedFolders.join(",").toLowerCase()}::` +
      `${this.settings.allowedFileTypes.join(",").toLowerCase()}`;
  }

  private async scan(): Promise<string[]> {
    if (!(await this.checkMountPoint())) return [];

    const root = this.settings.koboMountPoint!;
    const excluded = new Set(
      this.settings.excludedFolders.map((f) => f.trim().toLowerCase()).filter(
        Boolean,
      ),
    );

    const results: string[] = [];
    await this.walk(root, excluded, results);
    devLog(`SDR scan finished. Found ${results.length} valid directories.`);
    return results;
  }

  private async walk(
    dir: string,
    excluded: Set<string>,
    out: string[],
  ): Promise<void> {
    try {
      const dh: Dir = await io(() => opendir(dir)); // <- Dir, never undefined
      try {
        for await (const entry of dh) {
          if (excluded.has(entry.name.toLowerCase())) continue;

          const path = joinPath(dir, entry.name);
          if (!entry.isDirectory()) continue;

          if (entry.name.endsWith(SDR_SUFFIX)) {
            if (await this.getMetadataFileName(path)) {
              out.push(path);
              continue; // don't recurse into *.sdr
            }
          }

          if (
            !entry.name.startsWith(".") &&
            entry.name !== "$RECYCLE.BIN"
          ) {
            await this.walk(path, excluded, out);
          }
        }
      } finally {
        await dh.close().catch(() => {});
      }
    } catch (err) {
      handleFileSystemError("reading directory", dir, err, {
        shouldThrow: false,
      });
    }
  }

  private async getMetadataFileName(dir: string): Promise<string | null> {
    const cached = this.metadataNameCache.get(dir);
    if (cached !== undefined) return cached;

    const allow = this.settings.allowedFileTypes
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const allowAll = allow.length === 0;

    let dh: Dir | undefined;
    try {
      dh = await io(() => opendir(dir));
      for await (const entry of dh) {
        if (!entry.isFile()) continue;
        const m = entry.name.match(METADATA_REGEX);
        if (!m) continue;

        const ext = m[1]?.toLowerCase();
        if (allowAll || allow.includes(ext)) {
          this.metadataNameCache.set(dir, entry.name);
          // Return inside the finally block after closing the handle.
          return entry.name;
        }
      }
    } catch (err) {
      handleFileSystemError("reading SDR directory", dir, err, {
        shouldThrow: false,
      });
    } finally {
      await dh?.close().catch(() => {});
    }

    this.metadataNameCache.set(dir, null);
    return null;
  }

  async checkMountPoint(): Promise<boolean> {
    const mp = this.settings.koboMountPoint;
    if (mp && (await this.isUsableDir(mp))) return true;

    devWarn("Mount point not accessible – attempting auto-detect");

    for (const candidate of await this.detectCandidates()) {
      if (await this.isUsableDir(candidate)) {
        this.settings.koboMountPoint = candidate;
        new Notice(`KOReader: auto-detected device at "${candidate}"`, 5000);
        devLog("Using auto-detected mount point:", candidate);
        this.updateCacheKey();
        return true;
      }
    }

    new Notice(
      "KOReader Importer: Kobo device not found – please check the path in settings.",
      7000,
    );
    return false;
  }

  private async isUsableDir(p: string): Promise<boolean> {
    try {
      const st = await fsStat(p);
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  private async detectCandidates(): Promise<string[]> {
    const out: string[] = [];
    if (platform() === "darwin") {
      const vols = await opendir("/Volumes").catch(() => null); // no limiter
      if (vols) {
        try {
          for await (const e of vols) {
            if (e.isDirectory() && e.name.toLowerCase().includes("kobo")) {
              out.push(joinPath("/Volumes", e.name));
            }
          }
        } finally {
          await vols.close().catch(() => {});
        }
      }
    } else if (platform() === "linux") {
      for (const root of ["/media", "/run/media"]) {
        const users = await opendir(root).catch(() => null);
        if (!users) continue;
        try {
          for await (const user of users) {
            if (!user.isDirectory()) continue;
            const userPath = joinPath(root, user.name);
            const devs = await opendir(userPath).catch(() => null);
            if (!devs) continue;
            try {
              for await (const dev of devs) {
                if (
                  dev.isDirectory() && dev.name.toLowerCase().includes("kobo")
                ) {
                  out.push(joinPath(userPath, dev.name));
                }
              }
            } finally {
              await devs.close().catch(() => {});
            }
          }
        } finally {
          await users.close().catch(() => {});
        }
      }
    } else if (platform() === "win32") {
      // Windows: look for KoboReader.sqlite in the drive root (E:/… etc.)
      for (const letter of "DEFGHIJKLMNOPQRSTUVWXYZ") {
        const root = `${letter}:/`; // <-- forward-slash
        try {
          await access(`${root}KoboReader.sqlite`); // simpler & separator-agnostic
          out.push(root); // will later be stat()-checked
        } catch { /* file not found – keep searching */ }
      }
    }
    return out;
  }
}
