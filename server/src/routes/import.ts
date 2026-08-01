/**
 * Playlist Import Routes — import playlists from external services
 *
 * POST /api/import/playlist   — parse URL, extract tracks, search matches
 * POST /api/import/save       — save matched tracks as a new playlist
 */

import { Hono } from "hono";
import { getVKProvider } from "../providers/vk.js";
import { getSoundCloudProvider } from "../providers/soundcloud.js";
import { getDb, createPlaylist, addTrackToPlaylist, upsertTrack, getYandexConfig } from "../db/index.js";
import { sidecarGet } from "../providers/sidecar.js";
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

function parseYandexMusicURL(url: string): { owner: string; kind: string } | { shareId: string } | null {
  // Classic format: /users/{owner}/playlists/{kind}
  const classic = url.match(/music\.yandex\.(ru|com)\/users\/([^\/]+)\/playlists\/(\d+)/);
  if (classic) return { owner: classic[2], kind: classic[3] };

  // New share format: /playlists/{uuid}
  const share = url.match(/music\.yandex\.(ru|com)\/playlists\/(lk\.[a-f0-9-]+|[a-f0-9-]+)/i);
  if (share) return { shareId: share[2] };

  return null;
}

async function resolveYandexShareUrl(shareId: string): Promise<{ owner: string; kind: string }> {
  const token = getYandexConfig().token;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  if (token) {
    headers["Authorization"] = `OAuth ${token}`;
  }

  // Fetch HTML page and extract owner login + kind — retry up to 2 times
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://music.yandex.ru/playlists/${encodeURIComponent(shareId)}`,
        {
          headers,
          signal: AbortSignal.timeout(20_000),
          redirect: "follow",
        }
      );
      if (!res.ok) { if (attempt === 0) continue; throw new Error(`Yandex returned ${res.status}`); }
      const html = await res.text();
      if (html.length < 1000) { if (attempt === 0) continue; throw new Error("Yandex returned empty page"); }

      const ownerMatch = html.match(/"owner":\{[^}]*?"login":"([^"]+)"/);
      const kindMatch = html.match(/"kind":(\d+)/);
      if (ownerMatch && kindMatch) return { owner: ownerMatch[1], kind: kindMatch[1] };
      if (attempt === 0) continue;
    } catch (err) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 1000)); continue; }
      throw err;
    }
  }
  throw new Error("Could not resolve playlist owner/kind from share URL");
}

async function fetchYandexPlaylist(owner: string, kind: string): Promise<{ title: string; tracks: ExternalTrack[] }> {
  const token = getYandexConfig().token;
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
  };
  if (token) {
    headers["Authorization"] = `OAuth ${token}`;
  }

  const res = await fetch(
    `https://music.yandex.ru/handlers/playlist.jsx?owner=${encodeURIComponent(owner)}&kinds=${kind}&light=false`,
    { headers, signal: AbortSignal.timeout(15_000) }
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
  const extArtist = normalizeForMatch(external.artist).split(",")[0].trim();
  const foundTitle = normalizeForMatch(found.title);
  const foundArtist = normalizeForMatch(found.artist);

  const titleExact = foundTitle === extTitle;
  const titleContains = foundTitle.includes(extTitle) || extTitle.includes(foundTitle);
  const artistContains = foundArtist.includes(extArtist) || extArtist.includes(foundArtist);

  // Also check if first word of artist matches (handles "DJ XYZ" vs "XYZ")
  const extArtistFirst = extArtist.split(" ").pop() ?? extArtist;
  const artistLoose = foundArtist.includes(extArtistFirst) && extArtistFirst.length >= 3;

  if (titleExact && artistContains) return "high";
  if (titleContains && artistContains) return "high";
  if (titleExact && artistLoose) return "medium";
  if (titleContains && artistLoose) return "medium";
  // If title matches closely, accept even with different artist (covers, remixes)
  if (titleExact) return "medium";
  return "none";
}

async function searchTrackAcrossProviders(ext: ExternalTrack): Promise<MatchedTrack> {
  const mainArtist = ext.artist.split(",")[0].trim();
  const cleanTitle = ext.title.replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "").trim();
  const query = `${mainArtist} ${cleanTitle}`;
  const result: MatchedTrack = { ...ext, confidence: "none" };

  // Try SoundCloud first (faster, no auth)
  try {
    const scTracks = await getSoundCloudProvider().search(query, 3);
    for (const t of scTracks) {
      const conf = matchConfidence(ext, t);
      if (conf !== "none") {
        return { ...result, match: t, matchSource: "soundcloud", confidence: conf };
      }
    }
    if (scTracks.length > 0) {
      return { ...result, match: scTracks[0], matchSource: "soundcloud", confidence: "medium" };
    }
  } catch { /* skip */ }

  // Fallback: VK
  try {
    const vkTracks = (await getVKProvider().search(query)).slice(0, 3);
    for (const t of vkTracks) {
      const conf = matchConfidence(ext, t);
      if (conf !== "none") {
        return { ...result, match: t, matchSource: "vk", confidence: conf };
      }
    }
    if (vkTracks.length > 0) {
      return { ...result, match: vkTracks[0], matchSource: "vk", confidence: "medium" };
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
      const identifier = "shareId" in ym ? ym.shareId : `${ym.owner}:${ym.kind}`;
      const token = getYandexConfig().token ?? "";
      const reqHeaders: Record<string, string> = {};
      if (token) reqHeaders["X-Yandex-Token"] = token;

      const result = await sidecarGet<{ title: string; tracks: ExternalTrack[] }>(
        `/yandex/playlist?id=${encodeURIComponent(identifier)}`,
        reqHeaders,
        35_000
      );
      playlistTitle = result.title;
      externalTracks = result.tracks;
    } catch (err) {
      try {
        let owner: string, kind: string;
        if ("shareId" in ym) {
          const resolved = await resolveYandexShareUrl(ym.shareId);
          owner = resolved.owner;
          kind = resolved.kind;
        } else {
          owner = ym.owner;
          kind = ym.kind;
        }
        const result = await fetchYandexPlaylist(owner, kind);
        playlistTitle = result.title;
        externalTracks = result.tracks;
      } catch (err2) {
        return c.json({ error: `Failed to fetch Yandex playlist: ${err2 instanceof Error ? err2.message : String(err2)}` }, 502);
      }
    }
  } else {
    return c.json({ error: "Unsupported URL. Currently supported: Yandex Music playlists" }, 400);
  }

  if (externalTracks.length === 0) {
    return c.json({ error: "Playlist is empty" }, 404);
  }

  // Optional limit (0 = no limit)
  const limitParam = Number(c.req.query("limit") ?? 0);
  if (limitParam > 0) externalTracks = externalTracks.slice(0, limitParam);

  // Search for matches — process in batches of 10 concurrently
  const BATCH = 10;
  const matches: MatchedTrack[] = [];
  for (let i = 0; i < externalTracks.length; i += BATCH) {
    const batch = externalTracks.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(
      batch.map((t) => searchTrackAcrossProviders(t))
    );
    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      if (r.status === "fulfilled") matches.push(r.value);
      else matches.push({ ...batch[j], confidence: "none" });
    }
  }

  // Upsert matched tracks into DB so they can be saved to playlists
  const matched = matches.filter((m) => m.confidence !== "none");
  for (const m of matched) {
    if (m.match) {
      try {
        upsertTrack({
          id: m.match.id,
          source: m.match.source,
          title: m.match.title,
          artist: m.match.artist,
          album: m.match.album,
          duration: m.match.duration ?? 0,
          cover_url: m.match.coverUrl,
        });
      } catch { /* skip duplicates */ }
    }
  }

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
