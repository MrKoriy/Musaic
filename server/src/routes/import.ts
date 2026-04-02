/**
 * Playlist Import Routes — import playlists from external services
 *
 * POST /api/import/playlist   — parse URL, extract tracks, search matches
 * POST /api/import/save       — save matched tracks as a new playlist
 */

import { Hono } from "hono";
import { getVKProvider } from "../providers/vk.js";
import { getSoundCloudProvider } from "../providers/soundcloud.js";
import { getDb, createPlaylist, addTrackToPlaylist, upsertTrack } from "../db/index.js";
import type { Track } from "../types.js";

const router = new Hono();

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExternalTrack {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  coverUrl?: string;
}

interface MatchedTrack extends ExternalTrack {
  match?: Track;
  matchSource?: string;
  confidence: "high" | "medium" | "none";
}

// ─── Yandex Music Parser ────────────────────────────────────────────────────

function parseYandexMusicURL(url: string): { owner: string; kind: string } | null {
  const m = url.match(/music\.yandex\.(ru|com)\/users\/([^\/]+)\/playlists\/(\d+)/);
  if (m) return { owner: m[2], kind: m[3] };
  return null;
}

async function fetchYandexPlaylist(owner: string, kind: string): Promise<{ title: string; tracks: ExternalTrack[] }> {
  const res = await fetch(
    `https://music.yandex.ru/handlers/playlist.jsx?owner=${encodeURIComponent(owner)}&kinds=${kind}&light=true`,
    { signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) throw new Error(`Yandex Music returned ${res.status}`);

  const data = await res.json() as {
    playlist?: {
      title?: string;
      tracks?: Array<{
        title?: string;
        artists?: Array<{ name?: string }>;
        albums?: Array<{ title?: string; coverUri?: string }>;
        durationMs?: number;
      }>;
    };
  };

  const playlist = data.playlist;
  if (!playlist?.tracks) throw new Error("Playlist not found or empty");

  const tracks: ExternalTrack[] = playlist.tracks
    .filter((t) => t.title && t.artists?.length)
    .map((t) => ({
      title: t.title!,
      artist: t.artists!.map((a) => a.name ?? "").join(", "),
      album: t.albums?.[0]?.title,
      durationSec: t.durationMs ? Math.round(t.durationMs / 1000) : undefined,
      coverUrl: t.albums?.[0]?.coverUri
        ? `https://${t.albums[0].coverUri.replace("%%", "200x200")}`
        : undefined,
    }));

  return { title: playlist.title ?? "Imported Playlist", tracks };
}

// ─── Track Matching ─────────────────────────────────────────────────────────

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/feat\.?[^,]*/gi, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchConfidence(external: ExternalTrack, found: Track): "high" | "medium" | "none" {
  const extTitle = normalizeForMatch(external.title);
  const extArtist = normalizeForMatch(external.artist);
  const foundTitle = normalizeForMatch(found.title);
  const foundArtist = normalizeForMatch(found.artist);

  if (foundTitle === extTitle && foundArtist.includes(extArtist.split(",")[0])) return "high";
  if (foundTitle.includes(extTitle) || extTitle.includes(foundTitle)) {
    if (foundArtist.includes(extArtist.split(",")[0]) || extArtist.includes(foundArtist.split(",")[0])) {
      return "medium";
    }
  }
  return "none";
}

async function searchTrackAcrossProviders(ext: ExternalTrack): Promise<MatchedTrack> {
  const query = `${ext.artist} ${ext.title}`;
  const result: MatchedTrack = { ...ext, confidence: "none" };

  // Search SoundCloud first (free, no auth needed)
  try {
    const scTracks = await getSoundCloudProvider().search(query, 3);
    for (const t of scTracks) {
      const conf = matchConfidence(ext, t);
      if (conf !== "none") {
        result.match = t;
        result.matchSource = "soundcloud";
        result.confidence = conf;
        if (conf === "high") return result;
      }
    }
  } catch { /* skip */ }

  // Then try VK
  try {
    const vkTracks = (await getVKProvider().search(query)).slice(0, 3);
    for (const t of vkTracks) {
      const conf = matchConfidence(ext, t);
      if (conf !== "none" && (result.confidence === "none" || conf === "high")) {
        result.match = t;
        result.matchSource = "vk";
        result.confidence = conf;
        if (conf === "high") return result;
      }
    }
  } catch { /* skip */ }

  return result;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/import/playlist
 * Body: { url: string }
 * Returns: { source, title, totalTracks, matches: MatchedTrack[] }
 */
router.post("/playlist", async (c) => {
  const body = await c.req.json<{ url?: string }>();
  const url = body.url?.trim();
  if (!url) return c.json({ error: "url required" }, 400);

  // Detect platform
  let source: string;
  let playlistTitle: string;
  let externalTracks: ExternalTrack[];

  const ym = parseYandexMusicURL(url);
  if (ym) {
    source = "yandex";
    try {
      const result = await fetchYandexPlaylist(ym.owner, ym.kind);
      playlistTitle = result.title;
      externalTracks = result.tracks;
    } catch (err) {
      return c.json({ error: `Failed to fetch Yandex playlist: ${err instanceof Error ? err.message : "unknown"}` }, 502);
    }
  } else {
    return c.json({ error: "Unsupported URL. Currently supported: Yandex Music playlists" }, 400);
  }

  if (externalTracks.length === 0) {
    return c.json({ error: "Playlist is empty" }, 404);
  }

  // Search for matches — process in batches of 3 to avoid rate limits
  const matches: MatchedTrack[] = [];
  for (let i = 0; i < externalTracks.length; i += 3) {
    const batch = externalTracks.slice(i, i + 3);
    const batchResults = await Promise.allSettled(
      batch.map((t) => searchTrackAcrossProviders(t))
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled") matches.push(r.value);
      else matches.push({ ...batch[batchResults.indexOf(r)], confidence: "none" });
    }
    // Small delay between batches
    if (i + 3 < externalTracks.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const matched = matches.filter((m) => m.confidence !== "none");

  return c.json({
    source,
    title: playlistTitle,
    totalTracks: externalTracks.length,
    matchedCount: matched.length,
    matches,
  });
});

/**
 * POST /api/import/save
 * Body: { name: string, trackIds: string[] }
 * Saves matched tracks as a new playlist
 */
router.post("/save", async (c) => {
  const body = await c.req.json<{ name?: string; trackIds?: string[] }>();
  const name = body.name?.trim();
  const trackIds = body.trackIds;

  if (!name) return c.json({ error: "name required" }, 400);
  if (!trackIds?.length) return c.json({ error: "trackIds required" }, 400);

  const userId = (c as any).get("userId") as string | undefined;
  const db = getDb();

  // Verify tracks exist
  const existing = trackIds.filter((id) => {
    return db.prepare("SELECT 1 FROM tracks WHERE id = $id").get({ $id: id });
  });

  if (existing.length === 0) {
    return c.json({ error: "No valid tracks found" }, 400);
  }

  const crypto = await import("crypto");
  const playlistId = "import_" + crypto.randomBytes(8).toString("hex");
  createPlaylist(playlistId, name, `Imported from external service (${existing.length} tracks)`, userId);

  for (let i = 0; i < existing.length; i++) {
    addTrackToPlaylist(playlistId, existing[i], i);
  }

  return c.json({ ok: true, id: playlistId, trackCount: existing.length });
});

export default router;
