/**
 * YouTube Music provider.
 *
 * Search/metadata via ytmusicapi, stream resolution via yt-dlp — both in the
 * Python sidecar. No auth required. yt-dlp returns a googlevideo URL that
 * supports HTTP Range, so the server's /downloads/stream proxy can cache and
 * range-serve it like any other source.
 */

import type { Track, TrackMeta, MusicProvider } from "../types.js";
import { upsertTrack, getDb } from "../db/index.js";
import { sidecarGet, type SidecarTrack } from "./sidecar.js";
import { hydrateFallbackArtwork } from "./artwork.js";

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

  async search(query: string, count = 30, offset = 0): Promise<Track[]> {
    // ytmusicapi has no offset; only contribute to the first page to avoid dupes.
    if (offset > 0) return [];
    const { tracks } = await sidecarGet<{ tracks: SidecarTrack[] }>(
      `/yt/search?q=${encodeURIComponent(query)}&count=${count}`
    );
    const mapped = await hydrateFallbackArtwork(tracks.map(sidecarTrackToTrack));
    cacheYouTubeTracks(mapped);
    return mapped;
  }

  async getArtistTracks(artistName: string): Promise<Track[]> {
    const { tracks } = await sidecarGet<{ tracks: SidecarTrack[] }>(
      `/yt/artist?name=${encodeURIComponent(artistName)}&count=100`
    );
    const mapped = await hydrateFallbackArtwork(tracks.map(sidecarTrackToTrack));
    cacheYouTubeTracks(mapped);
    return mapped;
  }

  async getTrackMetadata(trackId: string): Promise<TrackMeta> {
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
  async getStreamUrl(trackId: string): Promise<string> {
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
