/**
 * Online Artwork Provider
 *
 * Fetches album art from free public APIs:
 *   1. iTunes Search API (primary) — no auth required
 *   2. Deezer API (fallback)       — no auth required
 *
 * Also exports shared track artwork hydration helpers used by search + providers.
 */

import { getDb } from "../db/index.js";
import type { Track } from "../types.js";

export interface ArtworkResult {
  url: string;
  source: "itunes" | "deezer";
}

function normalizedArtworkQueries(artist: string, title: string): string[] {
  const clean = (value: string): string =>
    value
      .replace(/\([^)]*\)/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const cleanedArtist = clean(artist);
  const cleanedTitle = clean(title);

  return Array.from(new Set([
    `${artist} ${title}`.trim(),
    `${cleanedArtist} ${cleanedTitle}`.trim(),
    cleanedArtist,
  ].filter((query) => query.length > 0)));
}

async function fetchFromITunes(query: string): Promise<ArtworkResult | null> {
  const q = encodeURIComponent(query);
  const res = await fetch(
    `https://itunes.apple.com/search?term=${q}&entity=song&limit=1`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!res.ok) return null;

  const data = (await res.json()) as {
    results?: Array<{ artworkUrl100?: string }>;
  };
  const raw = data.results?.[0]?.artworkUrl100;
  if (!raw) return null;

  return {
    url: raw.replace("/100x100bb.", "/600x600bb."),
    source: "itunes",
  };
}

async function fetchFromDeezer(query: string): Promise<ArtworkResult | null> {
  const q = encodeURIComponent(query);
  const res = await fetch(
    `https://api.deezer.com/search?q=${q}&limit=1`,
    { signal: AbortSignal.timeout(6000) }
  );
  if (!res.ok) return null;

  const data = (await res.json()) as {
    data?: Array<{
      album?: { cover_big?: string; cover_medium?: string };
    }>;
  };
  const coverUrl =
    data.data?.[0]?.album?.cover_big ??
    data.data?.[0]?.album?.cover_medium;
  if (!coverUrl) return null;

  return { url: coverUrl, source: "deezer" };
}

/**
 * Fetch artwork URL for a given artist + title.
 * Returns null if neither source returns a result.
 */
export async function fetchOnlineArtwork(
  artist: string,
  title: string
): Promise<ArtworkResult | null> {
  const queries = normalizedArtworkQueries(artist, title);

  for (const query of queries) {
    try {
      const result = await fetchFromITunes(query);
      if (result) return result;
    } catch {
      // keep trying other providers/queries
    }
  }

  for (const query of queries) {
    try {
      const result = await fetchFromDeezer(query);
      if (result) return result;
    } catch {
      // keep trying other providers/queries
    }
  }

  return null;
}

/**
 * Fill in missing coverUrls from the SQLite DB cache (fast, synchronous).
 * Useful when a provider returns tracks that were previously enriched and stored.
 */
export function hydrateCachedCoverUrls(tracks: Track[]): Track[] {
  const missingTrackIDs = tracks
    .filter((track) => !track.coverUrl)
    .map((track) => track.id);

  if (missingTrackIDs.length === 0) return tracks;

  const db = getDb();
  const bindings = Object.fromEntries(
    missingTrackIDs.map((id, index) => [`$id${index}`, id])
  );
  const placeholders = missingTrackIDs.map((_, index) => `$id${index}`).join(", ");
  const rows = db.prepare(
    `SELECT id, cover_url FROM tracks WHERE id IN (${placeholders}) AND cover_url IS NOT NULL`
  ).all(bindings) as Array<{ id: string; cover_url: string }>;

  if (rows.length === 0) return tracks;

  const coverByID = new Map(rows.map((row) => [row.id, row.cover_url]));
  return tracks.map((track) => ({
    ...track,
    coverUrl: track.coverUrl ?? coverByID.get(track.id),
  }));
}

/**
 * Enrich tracks with artwork: DB cache first, then iTunes/Deezer for any still missing.
 * Limits external fetches to 16 tracks with 4 concurrent workers to keep latency low.
 */
export async function hydrateFallbackArtwork(tracks: Track[]): Promise<Track[]> {
  const hydratedFromCache = hydrateCachedCoverUrls(tracks);
  const pending = hydratedFromCache.filter((track) => !track.coverUrl).slice(0, 16);
  if (pending.length === 0) return hydratedFromCache;

  const byID = new Map(hydratedFromCache.map((track) => [track.id, { ...track }]));
  let cursor = 0;
  const concurrency = Math.min(4, pending.length);

  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < pending.length) {
      const current = pending[cursor++];
      try {
        const artwork = await fetchOnlineArtwork(current.artist, current.title);
        if (!artwork?.url) continue;
        const track = byID.get(current.id);
        if (track && !track.coverUrl) {
          track.coverUrl = artwork.url;
        }
      } catch {
        // best effort only
      }
    }
  });

  await Promise.all(workers);
  return hydratedFromCache.map((track) => byID.get(track.id) ?? track);
}
