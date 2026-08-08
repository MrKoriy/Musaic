/**
 * Yandex Music provider.
 *
 * Talks to the Python sidecar (MarshalX/yandex-music). The account OAuth token
 * is stored encrypted in our DB and forwarded to the sidecar per request. All
 * Yandex network egress (incl. the optional RU proxy) happens inside the
 * sidecar; audio is streamed back through the server's own /downloads/stream
 * proxy, so the phone never talks to Yandex directly.
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
import { getYandexConfig, setYandexConfig, clearYandexConfig, upsertTrack, getDb } from "../db/index.js";
import { sidecarFetch, sidecarGet, type SidecarTrack } from "./sidecar.js";
import { hydrateFallbackArtwork } from "./artwork.js";

function rawId(trackId: string): string {
  return trackId.replace(/^yandex_/, "");
}

function sidecarTrackToTrack(s: SidecarTrack): Track {
  return {
    id: s.id,
    source: "yandex",
    title: s.title,
    artist: s.artist,
    album: s.album ?? undefined,
    genre: s.genre ?? undefined,
    duration: s.duration,
    coverUrl: s.coverUrl ?? undefined,
  };
}

function cacheYandexTracks(tracks: Track[]): void {
  const db = getDb();
  db.transaction(() => {
    for (const t of tracks) {
      upsertTrack({
        id: t.id,
        source: "yandex",
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
        cover_url: t.coverUrl,
        genre: t.genre,
      });
    }
  })();
}

/** Offline fallback: search the local DB cache of previously-seen Yandex tracks. */
export function searchCachedYandexTracks(query: string, limit = 50, offset = 0): Track[] {
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
         WHERE fts MATCH $q AND t.source = 'yandex'
         ORDER BY rank LIMIT $limit OFFSET $offset`
      )
      .all({ $q: `${q}*`, $limit: safeLimit, $offset: safeOffset }) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      source: "yandex",
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

export class YandexMusicProvider implements MusicProvider {
  private requireToken(): string {
    const token = getYandexConfig().token;
    if (!token) throw new Error("Yandex is not connected. Add your Yandex token in Settings.");
    return token;
  }

  private headers(): Record<string, string> {
    return { "X-Yandex-Token": this.requireToken() };
  }

  isAuthenticated(): boolean {
    return !!getYandexConfig().token;
  }

  getUsername(): string | null {
    return getYandexConfig().username;
  }

  /** Store a token (validated by the caller via validate()). */
  setToken(token: string, username = "Yandex User"): void {
    setYandexConfig({ token, username });
  }

  logout(): void {
    clearYandexConfig();
  }

  /** Verify the token can reach Yandex and report the account login/plus state. */
  async validate(): Promise<{ login: string | null; plus: boolean }> {
    const res = await sidecarGet<{ ok: boolean; login: string | null; plus: boolean }>(
      "/yandex/validate",
      this.headers()
    );
    if (res.login && res.login !== getYandexConfig().username) {
      setYandexConfig({ username: res.login });
    }
    return { login: res.login, plus: res.plus };
  }

  search(query: string, options?: ProviderSearchOptions): Promise<Track[]>;
  search(query: string, count?: number, offset?: number): Promise<Track[]>;
  async search(
    query: string,
    optionsOrCount: ProviderSearchOptions | number = {},
    legacyOffset = 0,
  ): Promise<Track[]> {
    const { limit: count, offset } = resolveProviderSearchOptions(optionsOrCount, legacyOffset, 30);
    const page = count > 0 ? Math.floor(offset / count) : 0;
    const { tracks } = await sidecarGet<{ tracks: SidecarTrack[] }>(
      `/yandex/search?q=${encodeURIComponent(query)}&count=${count}&page=${page}`,
      this.headers()
    );
    const mapped = await hydrateFallbackArtwork(tracks.map(sidecarTrackToTrack));
    cacheYandexTracks(mapped);
    return mapped;
  }

  async getArtistTracks(artistName: string, options?: ProviderArtistOptions): Promise<Track[]> {
    const count = Math.max(1, Math.min(Math.floor(options?.limit ?? 100), 100));
    const { tracks } = await sidecarGet<{ tracks: SidecarTrack[] }>(
      `/yandex/artist?name=${encodeURIComponent(artistName)}&count=${count}`,
      this.headers()
    );
    const mapped = await hydrateFallbackArtwork(tracks.map(sidecarTrackToTrack));
    cacheYandexTracks(mapped);
    return mapped;
  }

  /** Yandex Rotor is only a candidate source; Musaic reranks the result. */
  async getStationTracks(station = "user:onyourwave", count = 50): Promise<Track[]> {
    const safeCount = Math.max(1, Math.min(Math.floor(count), 100));
    const { tracks } = await sidecarGet<{ tracks: SidecarTrack[] }>(
      `/yandex/station?station=${encodeURIComponent(station)}&count=${safeCount}`,
      this.headers()
    );
    const mapped = await hydrateFallbackArtwork(
      tracks.filter((track) => track.available !== false).map(sidecarTrackToTrack)
    );
    cacheYandexTracks(mapped);
    return mapped;
  }

  async getLikedTracks(): Promise<{ tracks: Track[]; likedAt: Map<string, number>; total: number }> {
    const response = await sidecarGet<{
      tracks: SidecarTrack[];
      likedAt?: Record<string, number>;
      total?: number;
    }>("/yandex/likes", this.headers(), 120_000);
    const tracks = await hydrateFallbackArtwork(
      (response.tracks ?? []).filter((track) => track.available !== false).map(sidecarTrackToTrack)
    );
    cacheYandexTracks(tracks);
    const likedAt = new Map<string, number>();
    for (const [id, timestamp] of Object.entries(response.likedAt ?? {})) {
      if (Number.isFinite(Number(timestamp))) {
        likedAt.set(id.startsWith("yandex_") ? id : `yandex_${id}`, Number(timestamp));
      }
    }
    return { tracks, likedAt, total: Number(response.total ?? tracks.length) };
  }

  async getTrackMetadata(trackId: string, _options?: ProviderMetadataOptions): Promise<TrackMeta> {
    const s = await sidecarGet<SidecarTrack>(`/yandex/track/${encodeURIComponent(rawId(trackId))}`, this.headers());
    const [track] = await hydrateFallbackArtwork([sidecarTrackToTrack(s)]);
    return {
      id: track.id,
      source: "yandex",
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      coverUrl: track.coverUrl,
      bitrate: 320,
    };
  }

  /**
   * Legacy callers should use stream() instead. Never put the account token in
   * a URL: URLs are routinely logged and cached by clients and proxies.
   */
  async getStreamUrl(trackId: string, opts?: ProviderStreamOptions): Promise<string> {
    const bitrate = opts?.bitrate ?? 320;
    const codec = opts?.codec ?? "mp3";
    return `/api/yandex/proxy/${encodeURIComponent(rawId(trackId))}?codec=${codec}&bitrate=${bitrate}`;
  }

  async stream(trackId: string, opts?: { bitrate?: number; codec?: "mp3" | "aac" }, range?: string): Promise<Response> {
    const bitrate = opts?.bitrate ?? 320;
    const codec = opts?.codec ?? "mp3";
    const headers = this.headers();
    if (range) headers.Range = range;
    return sidecarFetch(
      `/yandex/download/${encodeURIComponent(rawId(trackId))}?codec=${codec}&bitrate=${bitrate}`,
      headers,
      120_000,
    );
  }
}

let _provider: YandexMusicProvider | null = null;
export function getYandexProvider(): YandexMusicProvider {
  if (!_provider) _provider = new YandexMusicProvider();
  return _provider;
}
