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

// Kate Mobile app credentials — override via env if desired
const KATE_APP_ID = process.env.VK_APP_ID ?? "2685278";
const KATE_SECRET = process.env.VK_APP_SECRET ?? "lxhD8OD7dMsqtXIm5IUY";
const VK_API_VERSION = "5.131";
const VK_API_BASE = "https://api.vk.com/method";

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
  album?: {
    id: number;
    title: string;
    thumb?: {
      photo_135: string;
      photo_270: string;
      photo_600: string;
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

function vkItemToTrack(item: VKAudioItem): Track {
  const id = vkTrackId(item);
  const coverUrl =
    item.album?.thumb?.photo_270 ??
    item.album?.thumb?.photo_135 ??
    undefined;
  return {
    id,
    source: "vk",
    title: item.title.trim(),
    artist: item.artist.trim(),
    album: item.album?.title,
    duration: item.duration,
    coverUrl,
    streamUrl: item.url || undefined,
  };
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
      { id: KATE_APP_ID, secret: KATE_SECRET, ua: "KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; unknown Android SDK built for x86; en)", name: "Kate" },
      { id: process.env.VK_OFFICIAL_APP_ID ?? "2274003", secret: process.env.VK_OFFICIAL_APP_SECRET ?? "hHbZxrka2uZ6jB1inYsH", ua: "VKAndroidApp/5.52-4543 (Android 5.1.1; SDK 22; x86_64; unknown Android SDK built for x86_64; en; 320x240)", name: "VK Official" },
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

        const res = await fetch(`https://oauth.vk.com/token?${params}`, {
          headers: { "User-Agent": client.ua },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          lastError = `VK auth HTTP error: ${res.status} (${client.name})`;
          continue;
        }
        const data = (await res.json()) as {
          access_token?: string;
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
        setVkConfig({ username, token: this.token });
        console.log(`[VK] Authenticated successfully via ${client.name}`);
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
      throw new Error(`VK API ${method} HTTP error: ${res.status}`);
    }
    const json = (await res.json()) as VKApiResponse<T>;
    if (json.error) {
      if (json.error.error_code === 5) {
        // Auth error — clear token from memory AND database
        this.token = null;
        clearVkConfig();
        throw new Error("VK token expired or invalid. Re-authenticate.");
      }
      throw new Error(`VK API error ${json.error.error_code}: ${json.error.error_msg}`);
    }
    if (json.response === undefined) {
      throw new Error(`VK API ${method}: unexpected response shape`);
    }
    return json.response;
  }

  async search(query: string): Promise<Track[]> {
    const resp = await this.apiCall<{ count: number; items: VKAudioItem[] }>(
      "audio.search",
      { q: query, count: 50, auto_complete: 1, sort: 2 }
    );
    const tracks = resp.items.map(vkItemToTrack);
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
    return {
      id: vkTrackId(item),
      source: "vk",
      title: item.title.trim(),
      artist: item.artist.trim(),
      album: item.album?.title,
      duration: item.duration,
      coverUrl: item.album?.thumb?.photo_270,
      bitrate: 128, // VK typically 128-320kbps MP3
    };
  }

  async getArtistTracks(artistId: string): Promise<Track[]> {
    const resp = await this.apiCall<{ count: number; items: VKAudioItem[] }>(
      "audio.search",
      { q: artistId, count: 100, sort: 0, performer_only: 1 }
    );
    const tracks = resp.items.map(vkItemToTrack);
    cacheVKTracks(tracks);
    return tracks;
  }

  /** Get user's full audio library */
  async getUserLibrary(offset = 0, count = 100): Promise<Track[]> {
    const resp = await this.apiCall<{ count: number; items: VKAudioItem[] }>(
      "audio.get",
      { count, offset }
    );
    const tracks = resp.items.map(vkItemToTrack);
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
        Referer: "https://vk.com/",
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
    return resp.items.map(vkItemToTrack);
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
    const tracks = resp.items.map(vkItemToTrack);
    cacheVKTracks(tracks);
    return tracks;
  }

  /** Set token directly (from OAuth browser flow) */
  setToken(token: string, username: string): void {
    this.token = token;
    setVkConfig({ username, token });
    console.log(`[VK] Token set for ${username}`);
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
