import { Hono } from "hono";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseFile } from "music-metadata";
import {
  getDb,
  upsertTrack,
  setCoverData,
  updateTrackCoverUrl,
} from "../../db/index.js";
import { fetchOnlineArtwork } from "../../providers/artwork.js";

const AUDIO_EXTENSIONS = new Set([".flac", ".mp3", ".m4a", ".wav", ".ogg", ".opus", ".aiff", ".aif"]);

let scanStatus: { scanning: boolean; scanned: number; total: number; lastScanAt: number | null } = {
  scanning: false,
  scanned: 0,
  total: 0,
  lastScanAt: null,
};

/** Recursively walk a directory and return all audio file paths */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(fullPath));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(ext)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // Skip inaccessible dirs
  }
  return results;
}

function inferMoodFromGenre(genre: string | undefined): string | undefined {
  if (!genre) return undefined;
  const normalized = genre.toLowerCase();

  if (/(ambient|drone|sleep|meditation|classical|new age)/.test(normalized)) return "Sleep, Relax, Focus";
  if (/(house|dance|edm|club|disco|electro|techno|trance)/.test(normalized)) return "Party, Energise";
  if (/(hip hop|rap|trap|drill|grime)/.test(normalized)) return "Workout, Energise";
  if (/(rock|metal|punk|hardcore)/.test(normalized)) return "Workout, Energise";
  if (/(jazz|lofi|lo-fi|chill|downtempo)/.test(normalized)) return "Relax, Focus";
  if (/(r&b|soul|love|romance|ballad)/.test(normalized)) return "Romance, Feel good";
  if (/(pop|funk|indie pop|dance pop)/.test(normalized)) return "Feel good, Party";
  if (/(blues|sad|emo|slowcore)/.test(normalized)) return "Sad";
  return undefined;
}

/** Process a single audio file: extract metadata and index into SQLite */
async function indexFile(filePath: string): Promise<void> {
  const id = "local_" + crypto.createHash("sha1").update(filePath).digest("hex");
  try {
    const meta = await parseFile(filePath, { skipCovers: false, duration: true });
    const common = meta.common;
    const format = meta.format;

    const title = common.title || path.basename(filePath, path.extname(filePath));
    const artist = common.artist || common.albumartist || "Unknown Artist";
    const album = common.album || "Unknown Album";
    const duration = Math.round(format.duration ?? 0);
    const bitrate = format.bitrate ? Math.round(format.bitrate / 1000) : undefined;
    const genre = common.genre?.map((entry) => entry.trim()).filter(Boolean).join(", ") || undefined;
    const comments = (common.comment ?? [])
      .map((entry) => typeof entry === "string" ? entry : entry.text ?? "")
      .filter(Boolean);
    const mood =
      comments.find((entry) => /^mood:/i.test(entry))?.replace(/^mood:/i, "").trim() ||
      inferMoodFromGenre(genre);

    let coverUrl: string | undefined;
    const picture = common.picture?.[0];
    if (picture) {
      const buf = Buffer.from(picture.data);
      setCoverData(id, buf, picture.format || "image/jpeg");
      coverUrl = `/api/covers/${encodeURIComponent(id)}`;
    }

    upsertTrack({
      id,
      source: "local",
      title,
      artist,
      album,
      duration,
      cover_url: coverUrl,
      local_path: filePath,
      genre,
      mood,
      metadata: { bitrate, format: format.codec, sampleRate: format.sampleRate },
    });
  } catch (err) {
    console.error(`[scan] Failed to parse ${filePath}:`, err instanceof Error ? err.message : err);
  }
}

export const localRouter = new Hono();

localRouter.post("/scan", async (c) => {
  if (scanStatus.scanning) {
    return c.json({ error: "Scan already in progress", status: scanStatus }, 409);
  }

  const body = await c.req.json<{ dir?: string }>().catch(() => ({} as { dir?: string }));
  const configuredMusicDir = process.env.MUSIC_DIR;
  const requestedDir = body.dir?.trim();
  const musicDir = requestedDir ?? configuredMusicDir;

  if (!musicDir) {
    return c.json({ error: "dir required (or set MUSIC_DIR env var)" }, 400);
  }
  const resolvedMusicDir = path.resolve(musicDir);
  if (configuredMusicDir && requestedDir && process.env.ALLOW_SCAN_ANY_DIR !== "1") {
    const allowedDir = path.resolve(configuredMusicDir);
    if (resolvedMusicDir !== allowedDir) {
      return c.json({ error: "Scanning arbitrary directories is disabled. Update MUSIC_DIR or set ALLOW_SCAN_ANY_DIR=1." }, 403);
    }
  }

  if (!fs.existsSync(resolvedMusicDir)) {
    return c.json({ error: `Directory not found: ${resolvedMusicDir}` }, 404);
  }

  scanStatus = { scanning: true, scanned: 0, total: 0, lastScanAt: null };

  (async () => {
    try {
      const files = walkDir(resolvedMusicDir);
      scanStatus.total = files.length;
      console.log(`[scan] Found ${files.length} audio files in ${resolvedMusicDir}`);

      for (const file of files) {
        await indexFile(file);
        scanStatus.scanned++;
        if (scanStatus.scanned % 50 === 0) {
          console.log(`[scan] Progress: ${scanStatus.scanned}/${scanStatus.total}`);
        }
      }

      scanStatus.lastScanAt = Date.now();
      console.log(`[scan] Done: ${scanStatus.scanned} tracks indexed`);

      // Background: fetch online artwork for tracks that have no embedded cover
      const db = getDb();
      const noArt = db
        .prepare("SELECT id, artist, title FROM tracks WHERE cover_url IS NULL AND source = 'local'")
        .all() as Array<{ id: string; artist: string; title: string }>;
      if (noArt.length > 0) {
        console.log(`[artwork] Fetching online artwork for ${noArt.length} tracks...`);
        let fetched = 0;
        // Process in batches of 5 concurrent fetches
        for (let i = 0; i < noArt.length; i += 5) {
          const batch = noArt.slice(i, i + 5);
          const results = await Promise.allSettled(
            batch.map(async (track) => {
              const result = await fetchOnlineArtwork(track.artist, track.title);
              if (result) {
                updateTrackCoverUrl(track.id, result.url);
                return true;
              }
              return false;
            })
          );
          fetched += results.filter((r) => r.status === "fulfilled" && r.value).length;
          // Small delay between batches to be polite to free APIs
          if (i + 5 < noArt.length) await new Promise((r) => setTimeout(r, 200));
        }
        console.log(`[artwork] Done: ${fetched}/${noArt.length} artworks fetched`);
      }
    } finally {
      scanStatus.scanning = false;
    }
  })();

  return c.json({ ok: true, message: "Scan started", status: scanStatus });
});

localRouter.get("/status", (c) => {
  const db = getDb();
  const countRow = db.prepare("SELECT COUNT(*) as count FROM tracks WHERE source = 'local'").get() as { count: number };
  return c.json({ ...scanStatus, indexedTracks: countRow.count });
});
