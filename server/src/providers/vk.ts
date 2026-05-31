/**
 * VK Music Provider
 *
 * Uses Kate Mobile app credentials to get an audio-enabled token.
 * VK audio URLs are IP-bound and expire ~24h — cached in SQLite.
 * Rate limit: ~3 req/sec safe.
 */

import { getCachedVkUrl, setCachedVkUrl, setVkConfig, getVkConfig, clearVkConfig, upsertTrack, getDb } from "../db/index.js";
import type { Track, TrackMeta, MusicProvider } from "../types.js";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { hydrateCachedCoverUrls, hydrateFallbackArtwork } from "./artwork.js";

// Kate Mobile app credentials — must be set via env vars
const KATE_APP_ID = process.env.VK_APP_ID;
const KATE_SECRET = process.env.VK_APP_SECRET;
const VK_API_VERSION = "5.131";
// VK migrated from vk.com to vk.ru in September 2025
const VK_API_BASE = "https://api.vk.ru/method";

// Rate limiting: 3 req/sec max
let _lastRequestTime = 0;
const MIN_INTERVAL_MS = 350; // ~2.85 req/sec to be safe

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  _lastRequestTime = Date.now();
}

interface VKApiResponse<T> {
  response?: T;
  error?: {
    error_code: number;
    error_msg: string;
  };
}

interface VKAudioItem {
  id: number;
  owner_id: number;
  title: string;
  artist: string;
  duration: number;
  url?: string;
  track_covers?: string[];
  photo_34?: string;
  photo_68?: string;
  photo_135?: string;
  photo_270?: string;
  photo_300?: string;
  photo_600?: string;
  photo_1200?: string;
  album?: {
    id: number;
    title: string;
    thumb?: {
      photo_34?: string;
      photo_68?: string;
      photo_135?: string;
      photo_270?: string;
      photo_300?: string;
      photo_600?: string;
      photo_1200?: string;
    };
  };
}

interface VKPlaylist {
  id: number;
  owner_id: number;
  title: string;
  description?: string;
  count: number;
  photo?: {
    photo_135?: string;
    photo_270?: string;
    photo_600?: string;
  };
}

function vkTrackId(item: VKAudioItem): string {
  return `vk_${item.owner_id}_${item.id}`;
}

function bestTrackCoverFromArray(trackCovers: string[] | undefined): string | undefined {
  if (!trackCovers || trackCovers.length === 0) {
    return undefined;
  }

  let bestUrl: string | undefined;
  let bestScore = -1;

  for (const url of trackCovers) {
    if (!url?.trim()) continue;

    let score = 0;
    try {
      const parsed = new URL(url);
      const size = parsed.searchParams.get("size");
      const match = size?.match(/^(\d+)x(\d+)$/);
      if (match) {
        score = Number(match[1]) * Number(match[2]);
      }
    } catch {
      score = 0;
    }

    if (score >= bestScore) {
      bestScore = score;
      bestUrl = url;
    }
  }

  return bestUrl;
}

function extractVKCoverUrl(item: VKAudioItem): string | undefined {
  const albumThumb = item.album?.thumb;

  return [
    albumThumb?.photo_1200,
    albumThumb?.photo_600,
    albumThumb?.photo_300,
    albumThumb?.photo_270,
    albumThumb?.photo_135,
    albumThumb?.photo_68,
    albumThumb?.photo_34,
    item.photo_1200,
    item.photo_600,
    item.photo_300,
    item.photo_270,
    item.photo_135,
    item.photo_68,
    item.photo_34,
    bestTrackCoverFromArray(item.track_covers),
  ].find((value) => typeof value === "string" && value.trim().length > 0);
}

function mergeVKAudioItems(base: VKAudioItem, extra: VKAudioItem): VKAudioItem {
  return {
    ...base,
    ...extra,
    album: extra.album ?? base.album,
    track_covers: extra.track_covers ?? base.track_covers,
  };
}

function vkItemToTrack(item: VKAudioItem): Track {
  const id = vkTrackId(item);
  return {
    id,
    source: "vk",
    title: item.title.trim(),
    artist: item.artist.trim(),
    album: item.album?.title,
    duration: item.duration,
    coverUrl: extractVKCoverUrl(item),
    streamUrl: item.url || undefined,
  };
}

function dbRowToVKTrack(row: Record<string, unknown>): Track {
  const id = row.id as string;
  return {
    id,
    source: "vk",
    title: row.title as string,
    artist: row.artist as string,
    album: row.album as string | undefined,
    duration: Number(row.duration ?? 0),
    coverUrl: row.cover_url as string | undefined,
    streamUrl: getCachedVkUrl(id) ?? undefined,
  };
}

export function searchCachedVKTracks(query: string, limit = 50, offset = 0): Track[] {
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
         WHERE fts MATCH $q AND t.source = 'vk'
         ORDER BY rank LIMIT $limit OFFSET $offset`
      )
      .all({ $q: `${q}*`, $limit: safeLimit, $offset: safeOffset }) as Record<string, unknown>[];
    return rows.map(dbRowToVKTrack);
  } catch {
    const like = `%${q.toLowerCase()}%`;
    const rows = db
      .prepare(
        `SELECT * FROM tracks
         WHERE source = 'vk'
           AND (lower(title) LIKE $like OR lower(artist) LIKE $like OR lower(COALESCE(album, '')) LIKE $like)
         ORDER BY artist ASC, title ASC
         LIMIT $limit OFFSET $offset`
      )
      .all({ $like: like, $limit: safeLimit, $offset: safeOffset }) as Record<string, unknown>[];
    return rows.map(dbRowToVKTrack);
  }
}

/** Batch-upsert VK tracks into the DB inside a single transaction. */
function cacheVKTracks(tracks: Track[]): void {
  const db = getDb();
  db.transaction(() => {
    for (const t of tracks) {
      upsertTrack({
        id: t.id,
        source: "vk",
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
        cover_url: t.coverUrl,
      });
      if (t.streamUrl) setCachedVkUrl(t.id, t.streamUrl);
    }
  })();
}

export class VKMusicProvider implements MusicProvider {
  private token: string | null = null;

  constructor() {
    // Load token from DB on init
    const cfg = getVkConfig();
    if (cfg.token) {
      this.token = cfg.token;
    }
  }

  /**
   * Authenticate with VK using username/password.
   * Uses Kate Mobile credentials to get audio-enabled token.
   */
  async authenticate(username: string, password: string): Promise<void> {
    // Try multiple VK app credentials (Kate Mobile, VK Official, VK Android)
    const clients = [
      { id: KATE_APP_ID ?? "", secret: KATE_SECRET ?? "", ua: "KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)", name: "Kate" },
      { id: process.env.VK_OFFICIAL_APP_ID ?? "", secret: process.env.VK_OFFICIAL_APP_SECRET ?? "", ua: "VKAndroidApp/5.52-4543 (Android 5.1.1; SDK 22; x86_64; unknown Android SDK built for x86_64; en; 320x240)", name: "VK Official" },
    ];

    let lastError = "";
    for (const client of clients) {
      try {
        const params = new URLSearchParams({
          grant_type: "password",
          client_id: client.id,
          client_secret: client.secret,
          username,
          password,
          scope: "audio,offline",
          v: VK_API_VERSION,
          "2fa_supported": "1",
        });

        const res = await fetch(`https://oauth.vk.ru/access_token?${params}`, {
          headers: { "User-Agent": client.ua },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          lastError = `VK auth HTTP error: ${res.status} (${client.name})`;
          continue;
        }
        const data = (await res.json()) as {
          access_token?: string;
          expires_in?: number;
          error?: string;
          error_description?: string;
          redirect_uri?: string;
        };

        if (data.error) {
          if (data.error === "need_validation" && data.redirect_uri) {
            throw new Error(`VK requires 2FA validation. Open: ${data.redirect_uri}`);
          }
          lastError = `${data.error}: ${data.error_description} (${client.name})`;
          // Flood control → try next client
          if (data.error === "9;Flood control" || data.error.includes("Flood")) continue;
          // invalid_client → try next client
          if (data.error === "invalid_client") continue;
          continue;
        }

        if (!data.access_token) {
          lastError = `No access_token in response (${client.name})`;
          continue;
        }

        this.token = data.access_token;
        // expires_in = 0 means non-expiring (Kate Mobile); otherwise unixepoch deadline
        const tokenExpiry = data.expires_in && data.expires_in > 0
          ? Math.floor(Date.now() / 1000) + data.expires_in
          : undefined;
        setVkConfig({ username, token: this.token, tokenExpiry });
        console.log(`[VK] Authenticated successfully via ${client.name}${tokenExpiry ? ` (expires in ${data.expires_in}s)` : ""}`);
        return;
      } catch (e) {
        if (e instanceof Error && e.message.includes("2FA")) throw e;
        lastError = e instanceof Error ? e.message : String(e);
      }
    }

    throw new Error(`VK auth failed with all clients: ${lastError}`);
  }

  private ensureToken(): string {
    if (!this.token) {
      throw new Error("VK not authenticated. Call POST /api/vk/auth first.");
    }
    return this.token;
  }

  private async apiCall<T>(method: string, params: Record<string, string | number>): Promise<T> {
    await rateLimit();
    const token = this.ensureToken();
    const qs = new URLSearchParams({
      access_token: token,
      v: VK_API_VERSION,
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      ),
    });
    const url = `${VK_API_BASE}/${method}?${qs}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status === 401) {
        this.token = null;
        clearVkConfig();
        throw new Error("VK token expired or invalid (HTTP 401). Re-authenticate via /api/vk/oauth-url.");
      }
      throw new Error(`VK API ${method} HTTP error: ${res.status}`);
    }
    const json = (await res.json()) as VKApiResponse<T>;
    if (json.error) {
      const code = json.error.error_code;
      if (code === 5) {
        this.token = null;
        clearVkConfig();
        throw new Error("VK token expired or invalid. Re-authenticate.");
      }
      if (code === 25) {
        throw new Error("VK token needs confirmation. Try re-authenticating via OAuth browser flow.");
      }
      if (code === 201) {
        throw new Error("VK audio access denied. Token must come from Kate Mobile OAuth (client_id 2685278) with 'audio' scope.");
      }
      if (code === 14) {
        const captchaImg = (json.error as any).captcha_img;
        throw new Error(`VK captcha required${captchaImg ? `: ${captchaImg}` : ". Slow down requests."}`);
      }
      if (code === 3 && method.startsWith("audio.")) {
        throw new Error("VK token has no audio API access. Reconnect VK with a client_id that supports audio methods.");
      }
      throw new Error(`VK API error ${code}: ${json.error.error_msg}`);
    }
    if (json.response === undefined) {
      throw new Error(`VK API ${method}: unexpected response shape`);
    }
    return json.response;
  }

  private async hydrateArtworkIfNeeded(items: VKAudioItem[]): Promise<VKAudioItem[]> {
    const missingArtwork = items.filter((item) => !extractVKCoverUrl(item));
    if (missingArtwork.length === 0) {
      return items;
    }

    const enriched = new Map<string, VKAudioItem>();
    const refs = missingArtwork.map((item) => `${item.owner_id}_${item.id}`);

    for (let idx = 0; idx < refs.length; idx += 100) {
      const batch = refs.slice(idx, idx + 100);
      try {
        const response = await this.apiCall<VKAudioItem[]>("audio.getById", {
          audios: batch.join(","),
        });
        for (const item of response) {
          enriched.set(vkTrackId(item), item);
        }
      } catch {
        // Best effort: keep original items if VK refuses extra metadata lookup.
        return items;
      }
    }

    if (enriched.size === 0) {
      return items;
    }

    return items.map((item) => {
      const detailed = enriched.get(vkTrackId(item));
      return detailed ? mergeVKAudioItems(item, detailed) : item;
    });
  }

  async search(query: string, count = 50, offset = 0): Promise<Track[]> {
    const safeCount = Math.max(1, Math.min(count, 300));
    const safeOffset = Math.max(0, offset);
    const resp = await this.apiCall<{ count: number; items: VKAudioItem[] }>(
      "audio.search",
      { q: query, count: safeCount, offset: safeOffset, auto_complete: 1, sort: 2 }
    );
    const items = await this.hydrateArtworkIfNeeded(resp.items);
    const tracks = await hydrateFallbackArtwork(items.map(vkItemToTrack));
    cacheVKTracks(tracks);
    return tracks;
  }

  async getStreamUrl(trackId: string): Promise<string> {
    // Check cache first
    const cached = getCachedVkUrl(trackId);
    if (cached) return cached;

    // Parse owner_id and audio_id from our composite ID: "vk_{owner_id}_{audio_id}"
    const parts = trackId.replace(/^vk_/, "").split("_");
    if (parts.length < 2) throw new Error(`Invalid VK track ID: ${trackId}`);
    const ownerId = parts[0];
    const audioId = parts[1];
    const audioRef = `${ownerId}_${audioId}`;

    const items = await this.apiCall<VKAudioItem[]>("audio.getById", {
      audios: audioRef,
    });
    if (!items || items.length === 0) {
      throw new Error(`VK track not found: ${trackId}`);
    }
    const item = items[0];
    if (!item.url) {
      throw new Error(`VK track ${trackId} has no stream URL (possibly restricted)`);
    }
    setCachedVkUrl(trackId, item.url);
    return item.url;
  }

  async getTrackMetadata(trackId: string): Promise<TrackMeta> {
    const parts = trackId.replace(/^vk_/, "").split("_");
    const audioRef = `${parts[0]}_${parts[1]}`;
    const items = await this.apiCall<VKAudioItem[]>("audio.getById", {
      audios: audioRef,
    });
    if (!items || items.length === 0) {
      throw new Error(`VK track not found: ${trackId}`);
    }
    const item = items[0];
    const [track] = await hydrateFallbackArtwork([vkItemToTrack(item)]);
    return {
      id: track.id,
      source: track.source,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      coverUrl: track.coverUrl,
      bitrate: 128, // VK typically 128-320kbps MP3
    };
  }

  async getArtistTracks(artistId: string): Promise<Track[]> {
    const resp = await this.apiCall<{ count: number; items: VKAudioItem[] }>(
      "audio.search",
      { q: artistId, count: 100, sort: 0, performer_only: 1 }
    );
    const items = await this.hydrateArtworkIfNeeded(resp.items);
    const tracks = await hydrateFallbackArtwork(items.map(vkItemToTrack));
    cacheVKTracks(tracks);
    return tracks;
  }

  /** Get user's full audio library */
  async getUserLibrary(offset = 0, count = 100): Promise<Track[]> {
    const resp = await this.apiCall<{ count: number; items: VKAudioItem[] }>(
      "audio.get",
      { count, offset }
    );
    const items = await this.hydrateArtworkIfNeeded(resp.items);
    const tracks = await hydrateFallbackArtwork(items.map(vkItemToTrack));
    cacheVKTracks(tracks);
    return tracks;
  }

  /** Download a VK track to local storage for offline play */
  async downloadTrack(trackId: string, downloadDir: string): Promise<string> {
    const streamUrl = await this.getStreamUrl(trackId);
    const track = await this.getTrackMetadata(trackId);

    // Safe filename: "Artist - Title.mp3"
    const safeArtist = track.artist.replace(/[/\\:*?"<>|]/g, "_");
    const safeTitle = track.title.replace(/[/\\:*?"<>|]/g, "_");
    const filename = `${safeArtist} - ${safeTitle}.mp3`;
    const localPath = path.join(downloadDir, filename);

    if (fs.existsSync(localPath)) {
      // Update DB with local path
      upsertTrack({
        id: track.id,
        source: "vk",
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        cover_url: track.coverUrl,
        local_path: localPath,
      });
      return localPath;
    }

    const res = await fetch(streamUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://vk.ru/",
      },
      signal: AbortSignal.timeout(120_000), // downloads can take a while
    });
    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status} for ${trackId}`);
    }

    // Ensure download dir exists
    fs.mkdirSync(downloadDir, { recursive: true });

    const writeStream = fs.createWriteStream(localPath);
    await new Promise<void>((resolve, reject) => {
      if (!res.body) {
        reject(new Error("No response body"));
        return;
      }
      // @ts-ignore — fetch body as Node stream
      Readable.fromWeb(res.body as unknown).pipe(writeStream);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Update DB with local path
    upsertTrack({
      id: track.id,
      source: "vk",
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      cover_url: track.coverUrl,
      local_path: localPath,
    });

    console.log(`[VK] Downloaded: ${filename}`);
    return localPath;
  }

  /** Get VK music recommendations based on user's listening */
  async getRecommendations(count = 50): Promise<Track[]> {
    const resp = await this.apiCall<{ count: number; items: VKAudioItem[] }>(
      "audio.getRecommendations",
      { count }
    );
    const items = await this.hydrateArtworkIfNeeded(resp.items);
    const tracks = await hydrateFallbackArtwork(items.map(vkItemToTrack));
    cacheVKTracks(tracks);
    return tracks;
  }

  /** Search VK playlists by query */
  async searchPlaylists(query: string, count = 5): Promise<import("./soundcloud.js").ExternalPlaylist[]> {
    try {
      const resp = await this.apiCall<{ count: number; items: VKPlaylist[] }>(
        "audio.searchPlaylists",
        { q: query, count }
      );
      return resp.items.map((p) => ({
        id: `vk_playlist_${p.owner_id}_${p.id}`,
        source: "vk",
        title: p.title,
        author: "VK",
        trackCount: p.count,
        coverUrl: p.photo?.photo_600 ?? p.photo?.photo_270 ?? undefined,
      }));
    } catch {
      // audio.searchPlaylists may not be available — fallback to user playlists filtered
      return [];
    }
  }

  /** Get user's VK playlists */
  async getPlaylists(offset = 0, count = 50): Promise<VKPlaylist[]> {
    const resp = await this.apiCall<{ count: number; items: VKPlaylist[] }>(
      "audio.getPlaylists",
      { count, offset }
    );
    return resp.items;
  }

  /** Get tracks from a specific VK playlist */
  async getPlaylistTracks(playlistId: number, ownerId?: number): Promise<Track[]> {
    const params: Record<string, string | number> = {
      count: 200,
      playlist_id: playlistId,
    };
    if (ownerId !== undefined) params.owner_id = ownerId;
    const resp = await this.apiCall<{ count: number; items: VKAudioItem[] }>(
      "audio.get",
      params
    );
    const items = await this.hydrateArtworkIfNeeded(resp.items);
    const tracks = await hydrateFallbackArtwork(items.map(vkItemToTrack));
    cacheVKTracks(tracks);
    return tracks;
  }

  /** Set token directly (from OAuth browser flow) */
  setToken(token: string, username: string): void {
    this.token = token;
    setVkConfig({ username, token });
    console.log(`[VK] Token set for ${username}`);
  }

  /** Verify that the current token can call VK audio methods. */
  async validateAudioAccess(): Promise<void> {
    await this.apiCall<{ count: number; items: VKAudioItem[] }>(
      "audio.search",
      { q: "test", count: 1 }
    );
  }

  isAuthenticated(): boolean {
    return !!this.token;
  }

  /** Returns the username stored in DB (for display) */
  getUsername(): string | null {
    return getVkConfig().username;
  }

  /** Clear authentication */
  logout(): void {
    this.token = null;
    clearVkConfig();
    console.log("[VK] Logged out");
  }
}

// Singleton
let _provider: VKMusicProvider | null = null;
export function getVKProvider(): VKMusicProvider {
  if (!_provider) _provider = new VKMusicProvider();
  return _provider;
}
