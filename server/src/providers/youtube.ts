/**
 * YouTube Music provider.
 *
 * Search/metadata via ytmusicapi, stream resolution via yt-dlp — both in the
 * Python sidecar. No auth required. yt-dlp returns a googlevideo URL that
 * supports HTTP Range, so the server's /downloads/stream proxy can cache and
 * range-serve it like any other source.
 */

import {
  resolveProviderSearchOptions,
  type ProviderArtistOptions,
  type ProviderMetadataOptions,
  type ProviderSearchOptions,
  type ProviderStreamOptions,
  type Track,
  type TrackMeta,
  type MusicProvider,
} from "../types.js";
import { upsertTrack, getDb } from "../db/index.js";
import { sidecarGet, type SidecarTrack } from "./sidecar.js";
import { hydrateFallbackArtwork } from "./artwork.js";
import { normalizeComparableText } from "../utils/track-identity.js";

function rawId(trackId: string): string {
  return trackId.replace(/^yt_/, "");
}

function sidecarTrackToTrack(s: SidecarTrack): Track {
  return {
    id: s.id,
    source: "youtube",
    title: s.title,
    artist: s.artist,
    album: s.album ?? undefined,
    duration: s.duration,
    coverUrl: s.coverUrl ?? undefined,
  };
}

function cacheYouTubeTracks(tracks: Track[]): void {
  const db = getDb();
  db.transaction(() => {
    for (const t of tracks) {
      upsertTrack({
        id: t.id,
        source: "youtube",
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
        cover_url: t.coverUrl,
      });
    }
  })();
}

// Tokens that carry no discriminating power when matching artist names.
const ARTIST_STOP_TOKENS = new Set(["the", "a", "an", "of", "and", "feat", "ft", "dj", "mc", "band", "official"]);

function normalizedArtistText(value: string): string {
  return normalizeComparableText(value);
}

function artistCredits(value: string): string[] {
  return value
    .split(/\s*(?:,|;|\/|\||\+|&|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bwith\b|\bx\b|\band\b)\s*/iu)
    .map(normalizedArtistText)
    .filter(Boolean);
}

function artistTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of value.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const token = raw.trim();
    if (!token || ARTIST_STOP_TOKENS.has(token)) continue;
    if (token.length >= 3 || (/^\d+$/.test(token) && token.length >= 2)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function isSubset<T>(a: Set<T>, b: Set<T>): boolean {
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function artistMatchScore(query: string, artist: string, allowPartial: boolean): number {
  const q = normalizedArtistText(query);
  const a = normalizedArtistText(artist);
  if (!q || !a) return -1;
  if (q === a) return 100;

  const queryCredits = new Set(artistCredits(query));
  const artistCreditList = artistCredits(artist);
  if (artistCreditList.some((credit) => queryCredits.has(credit))) return 95;

  const qTokens = artistTokens(q);
  const aTokens = artistTokens(a);
  if (qTokens.size === 0 || aTokens.size === 0) return -1;
  if (qTokens.size >= 2 && isSubset(qTokens, aTokens)) return 85;
  if (qTokens.size === 1 && aTokens.size === 1 && isSubset(qTokens, aTokens)) return 90;
  if (allowPartial && qTokens.size === 1 && isSubset(qTokens, aTokens)) return 60;
  return -1;
}

/**
 * True if a track's artist plausibly corresponds to the searched artist name.
 * Mirrors the sidecar's `_artist_matches` — the last line of defence against
 * YouTube returning "recommended" songs by unrelated performers for an
 * artist-page request (e.g. "FORTUNA 812" surfacing "Amazwi" tracks).
 */
export function artistNameMatches(query: string, artist: string): boolean {
  return artistMatchScore(query, artist, true) >= 0;
}

/** Strict ownership check for tracks placed on an artist profile. */
export function artistCreditMatches(query: string, artist: string): boolean {
  return artistMatchScore(query, artist, false) >= 0;
}

function cachedYouTubeTracksForArtist(artist: string, limit = 100): Track[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT * FROM tracks
      WHERE source = 'youtube' AND lower(artist) = lower($artist)
      ORDER BY updated_at DESC
      LIMIT $limit
    `)
    .all({ $artist: artist, $limit: Math.max(1, Math.min(limit, 200)) }) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    source: "youtube",
    title: row.title as string,
    artist: row.artist as string,
    album: (row.album as string | null) ?? undefined,
    duration: Number(row.duration ?? 0),
    coverUrl: (row.cover_url as string | null) ?? undefined,
  }));
}

export function searchCachedYouTubeTracks(query: string, limit = 50, offset = 0): Track[] {
  const db = getDb();
  const q = query.trim();
  if (!q) return [];
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const safeOffset = Math.max(0, offset);
  try {
    const rows = db
      .prepare(
        `SELECT t.* FROM tracks t
         JOIN tracks_fts fts ON t.rowid = fts.rowid
         WHERE fts MATCH $q AND t.source = 'youtube'
         ORDER BY rank LIMIT $limit OFFSET $offset`
      )
      .all({ $q: `${q}*`, $limit: safeLimit, $offset: safeOffset }) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      source: "youtube",
      title: row.title as string,
      artist: row.artist as string,
      album: (row.album as string | null) ?? undefined,
      duration: Number(row.duration ?? 0),
      coverUrl: (row.cover_url as string | null) ?? undefined,
    }));
  } catch {
    return [];
  }
}

export class YouTubeMusicProvider implements MusicProvider {
  isAuthenticated(): boolean {
    return true; // no auth required
  }

  search(query: string, options?: ProviderSearchOptions): Promise<Track[]>;
  search(query: string, count?: number, offset?: number): Promise<Track[]>;
  async search(
    query: string,
    optionsOrCount: ProviderSearchOptions | number = {},
    legacyOffset = 0,
  ): Promise<Track[]> {
    const { limit: count, offset } = resolveProviderSearchOptions(optionsOrCount, legacyOffset, 30);
    // ytmusicapi has no offset; only contribute to the first page to avoid dupes.
    if (offset > 0) return [];
    const { tracks } = await sidecarGet<{ tracks: SidecarTrack[] }>(
      `/yt/search?q=${encodeURIComponent(query)}&count=${count}`
    );
    const mapped = await hydrateFallbackArtwork(tracks.map(sidecarTrackToTrack));
    cacheYouTubeTracks(mapped);
    return mapped;
  }

  async getArtistTracks(artistName: string, options?: ProviderArtistOptions): Promise<Track[]> {
    const count = Math.max(1, Math.min(Math.floor(options?.limit ?? 100), 100));
    const { tracks } = await sidecarGet<{ tracks: SidecarTrack[] }>(
      `/yt/artist?name=${encodeURIComponent(artistName)}&count=${count}`
    );
    const mapped = await hydrateFallbackArtwork(tracks.map(sidecarTrackToTrack));

    // Validate before caching: artist-page pollution used to leak unrelated
    // tracks into both the card and the global recommendation candidate pool.
    const matching = mapped.filter((track) => artistCreditMatches(artistName, track.artist));
    if (matching.length > 0) {
      cacheYouTubeTracks(matching);
      return matching;
    }

    const cached = cachedYouTubeTracksForArtist(artistName);
    return cached.filter((track) => artistCreditMatches(artistName, track.artist));
  }

  async getTrackMetadata(trackId: string, _options?: ProviderMetadataOptions): Promise<TrackMeta> {
    const s = await sidecarGet<SidecarTrack>(`/yt/track/${encodeURIComponent(rawId(trackId))}`);
    const [track] = await hydrateFallbackArtwork([sidecarTrackToTrack(s)]);
    return {
      id: track.id,
      source: "youtube",
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      coverUrl: track.coverUrl,
      bitrate: 128,
    };
  }

  /** Resolve a direct googlevideo audio URL (Range-capable) via yt-dlp. */
  async getStreamUrl(trackId: string, _options?: ProviderStreamOptions): Promise<string> {
    const res = await sidecarGet<{ url: string }>(`/yt/stream/${encodeURIComponent(rawId(trackId))}`);
    if (!res.url) throw new Error(`No YouTube stream for ${trackId}`);
    return res.url;
  }
}

let _provider: YouTubeMusicProvider | null = null;
export function getYouTubeProvider(): YouTubeMusicProvider {
  if (!_provider) _provider = new YouTubeMusicProvider();
  return _provider;
}
