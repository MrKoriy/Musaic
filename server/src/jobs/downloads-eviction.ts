import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

export interface DownloadsEvictionResult {
  ttlDeleted: number;
  capDeleted: number;
  tmpDeleted: number;
  freedBytes: number;
  totalBytes: number;
}

interface CacheEntry {
  file: string;
  size: number;
  lastAccess: number; // epoch ms
}

const HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

function parseEnvDays(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseEnvBytes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/**
 * Collect evictable cache files under DOWNLOADS_DIR. The `archive/` subtree
 * holds listening-history exports and must never be touched; everything else
 * (top-level track caches and `compressed/` transcodes) is re-downloadable.
 */
function collectEntries(root: string): { entries: CacheEntry[]; tmpFiles: CacheEntry[] } {
  const entries: CacheEntry[] = [];
  const tmpFiles: CacheEntry[] = [];
  const scan = (dir: string, allowTmp: boolean) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of names) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name === "archive") continue;
        if (dir === root) scan(full, allowTmp);
        continue;
      }
      if (!dirent.isFile()) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const lastAccess = Math.max(stat.atimeMs, stat.mtimeMs);
      const entry: CacheEntry = { file: full, size: stat.size, lastAccess };
      if (allowTmp && dirent.name.endsWith(".tmp")) {
        tmpFiles.push(entry);
      } else if (!dirent.name.endsWith(".tmp")) {
        entries.push(entry);
      }
    }
  };
  scan(root, true);
  return { entries, tmpFiles };
}

function unlinkQuiet(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Evict the downloads cache: delete files not accessed within the TTL, then
 * enforce a total size cap by deleting the least recently used files first.
 * Files touched within the last hour are always spared (they may be the
 * currently playing track or an in-flight download).
 */
export function runDownloadsEvictionJob(): DownloadsEvictionResult {
  const root = path.resolve(process.env.DOWNLOADS_DIR ?? "downloads");
  const ttlDays = parseEnvDays("DOWNLOADS_TTL_DAYS", 60);
  const maxBytes = parseEnvBytes("DOWNLOADS_MAX_BYTES", 20 * 1024 ** 3);
  if (!fs.existsSync(root)) {
    return { ttlDeleted: 0, capDeleted: 0, tmpDeleted: 0, freedBytes: 0, totalBytes: 0 };
  }

  const { entries, tmpFiles } = collectEntries(root);
  const now = Date.now();
  const graceMs = HOUR_MS;
  let freedBytes = 0;
  let ttlDeleted = 0;
  let capDeleted = 0;
  let tmpDeleted = 0;

  // Leftover partial downloads from crashed fetches.
  for (const tmp of tmpFiles) {
    if (now - tmp.lastAccess < DAY_MS) continue;
    if (unlinkQuiet(tmp.file)) {
      tmpDeleted++;
      freedBytes += tmp.size;
    }
  }

  // TTL pass: untouched for longer than the window.
  const ttlCutoff = now - ttlDays * DAY_MS;
  const fresh: CacheEntry[] = [];
  for (const entry of entries) {
    if (entry.lastAccess < ttlCutoff) {
      if (unlinkQuiet(entry.file)) {
        ttlDeleted++;
        freedBytes += entry.size;
      }
    } else {
      fresh.push(entry);
    }
  }

  // Cap pass: oldest-accessed first until the cache fits.
  let totalBytes = fresh.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > maxBytes) {
    const ordered = [...fresh].sort((a, b) => a.lastAccess - b.lastAccess);
    for (const entry of ordered) {
      if (totalBytes <= maxBytes) break;
      if (now - entry.lastAccess < graceMs) continue;
      if (unlinkQuiet(entry.file)) {
        capDeleted++;
        freedBytes += entry.size;
        totalBytes -= entry.size;
      }
    }
  }

  if (ttlDeleted + capDeleted + tmpDeleted > 0) {
    const mb = (freedBytes / 1024 ** 2).toFixed(1);
    const totalMb = (totalBytes / 1024 ** 2).toFixed(1);
    log.info(
      "jobs",
      `downloads eviction: removed ${ttlDeleted} stale (>${ttlDays}d), ${capDeleted} for cap, ${tmpDeleted} tmp; freed ${mb}MB, cache now ${totalMb}MB`,
    );
  } else {
    log.info("jobs", "downloads eviction: nothing to remove");
  }

  return { ttlDeleted, capDeleted, tmpDeleted, freedBytes, totalBytes };
}
