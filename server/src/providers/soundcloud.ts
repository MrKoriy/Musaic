/**
 * SoundCloud Provider
 *
 * Uses the public SoundCloud API v2 with an auto-extracted client_id.
 * client_id is scraped from the SoundCloud web app JS bundle — it rotates
 * periodically, so we re-extract when API calls start failing with 401.
 *
 * Fallback: yt-dlp for stream extraction when direct API fails.
 * Quality: Opus 64kbps (free tier).
 */

import { upsertTrack, getDb } from "../db/index.js";
import type { Track, TrackMeta, MusicProvider } from "../types.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SC_API_BASE = "https://api-v2.soundcloud.com";
const SC_WEB_URL = "https://soundcloud.com";

// Rate limiting: ~1 req/500ms to avoid 429
let _lastScRequest = 0;
const SC_MIN_INTERVAL_MS = 500;

async function scRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - _lastScRequest;
  if (elapsed < SC_MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, SC_MIN_INTERVAL_MS - elapsed));
  }
  _lastScRequest = Date.now();
}

// ─── client_id management ────────────────────────────────────────────────────

let _clientId: string | null = null;
let _clientIdFetchedAt = 0;
const CLIENT_ID_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Deduplicated patterns for client_id across SC bundle versions (with g flag for matchAll)
const CLIENT_ID_PATTERNS: RegExp[] = [
  /[{,]\s*client_id\s*:\s*"([a-zA-Z0-9]{20,40})"/g,
  /\bclient_id=([a-zA-Z0-9]{20,40})\b/g,
];

function extractClientIdFromJs(js: string): string | null {
  for (const pattern of CLIENT_ID_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = js.matchAll(pattern);
    for (const match of matches) {
      const id = match[1];
      if (id && id.length >= 20) return id;
    }
  }
  return null;
}

/**
 * Extract client_id from SoundCloud's web app JS bundle.
 * SC embeds the client_id as a constant in their main script.
 * Checks all app scripts (not just last 6) for reliability.
 */
async function extractClientId(): Promise<string> {
  console.log("[SC] Extracting client_id from soundcloud.com...");

  const pageRes = await fetch(SC_WEB_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!pageRes.ok) throw new Error(`SC page fetch failed: ${pageRes.status}`);
  const html = await pageRes.text();

  // Inline script check — sometimes client_id appears in inline config
  const inlineId = extractClientIdFromJs(html);
  if (inlineId) {
    console.log(`[SC] Found client_id inline: ${inlineId.substring(0, 8)}...`);
    return inlineId;
  }

  // Find all script tags pointing to sndcdn assets
  const scriptMatches = html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g);
  const scriptUrls: string[] = [];
  for (const m of scriptMatches) {
    if (m[1]) scriptUrls.push(m[1]);
  }

  if (scriptUrls.length === 0) {
    throw new Error("SC: could not find app scripts in HTML");
  }

  // Check scripts in a smarter order: last 3, first 3, then the rest
  const prioritized = [
    ...scriptUrls.slice(-4),
    ...scriptUrls.slice(0, 3),
    ...scriptUrls.slice(3, -4),
  ];
  const unique = [...new Set(prioritized)];

  for (const scriptUrl of unique) {
    try {
      const res = await fetch(scriptUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://soundcloud.com/",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const js = await res.text();
      const id = extractClientIdFromJs(js);
      if (id) {
        console.log(`[SC] Extracted client_id: ${id.substring(0, 8)}... from ${scriptUrl.split("/").pop()}`);
        return id;
      }
    } catch {
      // continue trying other scripts
    }
  }

  throw new Error("SC: client_id not found in any script. SoundCloud may have changed their bundle format.");
}

async function getClientId(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && _clientId && now - _clientIdFetchedAt < CLIENT_ID_TTL_MS) {
    return _clientId;
  }

  // Check DB cache
  const db = getDb();
  if (!forceRefresh) {
    const row = db
      .prepare("SELECT token, token_expiry FROM vk_config WHERE id = 2")
      .get() as { token: string | null; token_expiry: number | null } | null;
    if (row?.token && row.token_expiry && now < row.token_expiry) {
      _clientId = row.token;
      _clientIdFetchedAt = now;
      return _clientId;
    }
  }

  const clientId = await extractClientId();
  _clientId = clientId;
  _clientIdFetchedAt = now;

  // Store in DB (reusing vk_config table with id=2 for SC)
  db.prepare(`
    INSERT INTO vk_config (id, token, token_expiry, updated_at)
    VALUES (2, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET token = excluded.token, token_expiry = excluded.token_expiry, updated_at = unixepoch()
  `).run(clientId, now + CLIENT_ID_TTL_MS);

  return clientId;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SCPlaylist {
  id: number;
  title: string;
  user: { username: string; id: number };
  track_count: number;
  duration: number; // ms
  artwork_url: string | null;
  permalink_url: string;
  tracks: SCTrack[];
}

interface SCUser {
  id: number;
  username: string;
  full_name?: string | null;
  avatar_url?: string | null;
  permalink?: string | null;
  permalink_url?: string | null;
  track_count?: number;
  followers_count?: number;
}

export interface ExternalPlaylist {
  id: string;
  source: string;
  title: string;
  author: string;
  trackCount: number;
  coverUrl?: string;
  duration?: number;
}

export interface ExternalArtist {
  id: string;
  source: "soundcloud";
  artist: string;
  track_count: number;
  album_count: number;
  cover_url?: string;
  source_id?: string;
  handle?: string;
  subtitle?: string;
}

interface SCTrack {
  id: number;
  title: string;
  user?: { username: string; id: number };
  duration?: number; // ms
  permalink_url: string;
  artwork_url: string | null;
  waveform_url: string | null;
  genre?: string | null;
  tag_list?: string | null;
  bpm?: number | null;
  streamable?: boolean;
  publisher_metadata?: {
    artist?: string;
    album_title?: string;
    release_title?: string;
  };
  media?: {
    transcodings: Array<{
      url: string;
      format: { protocol: string; mime_type: string };
    }>;
  };
}

interface SCCollection<T> {
  collection: T[];
  next_href?: string | null;
}

function scId(track: SCTrack): string {
  return `sc_${track.id}`;
}

function scArtist(track: SCTrack): string {
  const preferredArtist = track.publisher_metadata?.artist?.trim();
  if (preferredArtist) return preferredArtist;
  const username = track.user?.username?.trim();
  if (username) return username;
  return "Unknown Artist";
}

function scAlbum(track: SCTrack): string | undefined {
  const candidates = [
    track.publisher_metadata?.album_title,
    track.publisher_metadata?.release_title,
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }

  return undefined;
}

function scAvatarUrl(user: SCUser): string | undefined {
  return user.avatar_url?.replace("-large", "-t500x500") ?? undefined;
}

function scUserDisplayName(user: SCUser): string {
  return user.full_name?.trim() || user.username.trim() || "Unknown Artist";
}

function scUserToArtist(user: SCUser): ExternalArtist {
  return {
    id: `soundcloud:${user.id}`,
    source: "soundcloud",
    artist: scUserDisplayName(user),
    track_count: user.track_count ?? 0,
    album_count: 0,
    cover_url: scAvatarUrl(user),
    source_id: String(user.id),
    handle: user.username,
    subtitle: user.username === scUserDisplayName(user) ? undefined : user.username,
  };
}

function parseSCTagList(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  const parts = value.match(/"[^"]+"|[^\s]+/g) ?? [];
  return uniqueStrings(parts.map((part) => part.replace(/^"+|"+$/g, "").trim()).filter(Boolean), 8);
}

function uniqueStrings(values: string[], limit = 8): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function scGenre(track: SCTrack): string | undefined {
  const tags = uniqueStrings([
    track.genre?.trim() ?? "",
    ...parseSCTagList(track.tag_list),
  ]);

  return tags.length > 0 ? tags.join(", ") : undefined;
}

function isHydratedSCTrack(track: SCTrack): boolean {
  return Boolean(
    track.user?.username &&
    typeof track.duration === "number" &&
    track.duration > 45_000 && // must have real duration, not preview duration (30s = 30000ms)
    typeof track.streamable === "boolean"
  );
}

function scTrackToTrack(track: SCTrack): Track {
  const genre = scGenre(track);
  return {
    id: scId(track),
    source: "soundcloud",
    title: track.title,
    artist: scArtist(track),
    album: scAlbum(track),
    duration: Math.floor((track.duration ?? 0) / 1000),
    coverUrl: track.artwork_url?.replace("-large", "-t300x300") ?? undefined,
    waveformUrl: track.waveform_url ?? undefined,
    genre,
    metadata: {
      permalink: track.permalink_url,
      scId: track.id,
      bpm: track.bpm ?? undefined,
      tagList: parseSCTagList(track.tag_list),
      soundcloudGenre: track.genre ?? undefined,
    },
  };
}

function nextHrefRequest(nextHref: string): { path: string; params: Record<string, string> } | null {
  try {
    const url = new URL(nextHref);
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      if (key !== "client_id") params[key] = value;
    });
    return { path: url.pathname, params };
  } catch {
    return null;
  }
}

/** Batch-upsert SC tracks into the DB inside a single transaction. */
function cacheSCTracks(tracks: Track[]): void {
  const db = getDb();
  db.transaction(() => {
    for (const t of tracks) {
      upsertTrack({
        id: t.id,
        source: "soundcloud",
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
        cover_url: t.coverUrl,
        waveform_url: t.waveformUrl,
        genre: t.genre,
        metadata: t.metadata,
      });
    }
  })();
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class SoundCloudProvider implements MusicProvider {
  private async getUser(artistId: string): Promise<SCUser> {
    if (/^\d+$/.test(artistId)) {
      return this.apiGet<SCUser>(`/users/${artistId}`);
    }

    return this.apiGet<SCUser>("/resolve", {
      url: `https://soundcloud.com/${artistId}`,
    });
  }

  private async hydrateTracksIfNeeded(tracks: SCTrack[]): Promise<SCTrack[]> {
    const missingIDs = Array.from(new Set(
      tracks
        .filter((track) => !isHydratedSCTrack(track))
        .map((track) => track.id)
    ));

    if (missingIDs.length === 0) {
      return tracks;
    }

    const hydratedByID = new Map<number, SCTrack>();
    for (let index = 0; index < missingIDs.length; index += 50) {
      const batch = missingIDs.slice(index, index + 50);
      const hydrated = await this.apiGet<SCTrack[]>("/tracks", {
        ids: batch.join(","),
      });
      for (const track of hydrated) {
        hydratedByID.set(track.id, track);
      }
    }

    return tracks.map((track) => hydratedByID.get(track.id) ?? track);
  }

  private async apiGet<T>(
    path: string,
    params: Record<string, string | number> = {},
    retried = false
  ): Promise<T> {
    await scRateLimit();
    const clientId = await getClientId();
    const qs = new URLSearchParams({
      client_id: clientId,
      app_version: "1753523",
      app_locale: "en",
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)])
      ),
    });
    const url = `${SC_API_BASE}${path}?${qs}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json, text/javascript, */*; q=0.01",
        Origin: "https://soundcloud.com",
        Referer: "https://soundcloud.com/",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 401 && !retried) {
      // client_id expired — refresh and retry once
      console.log("[SC] 401 received, refreshing client_id...");
      await getClientId(true);
      return this.apiGet<T>(path, params, true);
    }

    if (!res.ok) {
      throw new Error(`SC API ${path} error: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  async search(query: string, limit = 30, offset = 0): Promise<Track[]> {
    const result = await this.apiGet<SCCollection<SCTrack>>("/search/tracks", {
      q: query,
      limit,
      offset,
      linked_partitioning: 1,
    });
    const tracks = result.collection
      .filter((t) => t.streamable && (t.duration ?? 0) > 45000) // skip 30-sec previews
      .map(scTrackToTrack);

    cacheSCTracks(tracks);
    return tracks;
  }

  async searchPlaylists(query: string, limit = 5): Promise<ExternalPlaylist[]> {
    const result = await this.apiGet<SCCollection<SCPlaylist>>("/search/playlists", {
      q: query,
      limit,
    });
    return result.collection.map((p) => ({
      id: `sc_playlist_${p.id}`,
      source: "soundcloud",
      title: p.title,
      author: p.user.username,
      trackCount: p.track_count,
      coverUrl: p.artwork_url?.replace("-large", "-t300x300") ?? undefined,
      duration: Math.floor(p.duration / 1000),
    }));
  }

  async searchArtists(query: string, limit = 5): Promise<ExternalArtist[]> {
    const result = await this.apiGet<SCCollection<SCUser>>("/search/users", {
      q: query,
      limit,
      linked_partitioning: 1,
    });
    return result.collection.map(scUserToArtist);
  }

  async getArtistInfo(artistId: string): Promise<ExternalArtist> {
    const user = await this.getUser(artistId);
    return scUserToArtist(user);
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    const scId = playlistId.replace(/^sc_playlist_/, "");
    const playlist = await this.apiGet<SCPlaylist>(`/playlists/${scId}`);
    const hydratedTracks = await this.hydrateTracksIfNeeded(playlist.tracks ?? []);
    const tracks = hydratedTracks
      .filter((t) => t.streamable && (t.duration ?? 0) > 45000 && t.user?.username)
      .map(scTrackToTrack);
    cacheSCTracks(tracks);
    return tracks;
  }

  async getStreamUrl(trackId: string): Promise<string> {
    const scNumericId = trackId.replace(/^sc_/, "");

    // Get track metadata with transcodings
    const track = await this.apiGet<SCTrack>(`/tracks/${scNumericId}`);
    if (!track.streamable) {
      throw new Error(`SC track ${trackId} is not streamable`);
    }

    // Prefer full-track transcodings over preview clips.
    // SC URLs containing "/preview/" are 30-second snippets; "/stream/" are full tracks.
    const transcodings = track.media?.transcodings ?? [];
    const streamTranscodings = transcodings.filter((t) => !t.url.includes("/preview/"));
    const pool = streamTranscodings.length > 0 ? streamTranscodings : transcodings;

    const progressive = pool.find(
      (t) =>
        t.format.protocol === "progressive" &&
        (t.format.mime_type.includes("mpeg") || t.format.mime_type.includes("mp3"))
    );
    const hls = pool.find((t) => t.format.protocol === "hls");
    const transcoding = progressive ?? hls ?? pool[0];

    if (!transcoding) {
      // Fallback to yt-dlp
      return this.getStreamUrlViaYtDlp(track.permalink_url);
    }

    // Resolve the transcoding URL to actual stream URL
    await scRateLimit();
    const clientId = await getClientId();
    const resolveRes = await fetch(
      `${transcoding.url}?client_id=${clientId}`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Origin: "https://soundcloud.com",
        },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!resolveRes.ok) {
      // Fallback to yt-dlp
      return this.getStreamUrlViaYtDlp(track.permalink_url);
    }
    const { url } = (await resolveRes.json()) as { url: string };
    return url;
  }

  /** yt-dlp fallback stream extraction */
  private async getStreamUrlViaYtDlp(permalinkUrl: string): Promise<string> {
    const ytdlpPath = process.env.YTDLP_PATH ?? "yt-dlp";
    try {
      const { stdout } = await execFileAsync(ytdlpPath, [
        "--get-url",
        "--no-warnings",
        "--format",
        "bestaudio",
        permalinkUrl,
      ]);
      const url = stdout.trim();
      if (!url) throw new Error("yt-dlp returned empty URL");
      return url;
    } catch (err: unknown) {
      throw new Error(
        `yt-dlp fallback failed for ${permalinkUrl}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async getTrackMetadata(trackId: string): Promise<TrackMeta> {
    const scNumericId = trackId.replace(/^sc_/, "");
    const track = await this.apiGet<SCTrack>(`/tracks/${scNumericId}`);
    return {
      id: scId(track),
      source: "soundcloud",
      title: track.title,
      artist: scArtist(track),
      album: scAlbum(track),
      duration: Math.floor((track.duration ?? 0) / 1000),
      coverUrl: track.artwork_url?.replace("-large", "-t300x300") ?? undefined,
      bitrate: 64, // Opus 64kbps on free tier
    };
  }

  private async getUserTracksPaged(userId: string | number, maxTracks: number): Promise<Track[]> {
    const pageLimit = 50;
    const maxPages = 8;
    let path = `/users/${userId}/tracks`;
    let params: Record<string, string | number> = {
      limit: pageLimit,
      linked_partitioning: 1,
    };
    const seen = new Set<number>();
    const tracks: Track[] = [];

    for (let page = 0; page < maxPages && tracks.length < maxTracks; page += 1) {
      const result = await this.apiGet<SCCollection<SCTrack>>(path, params);
      const collection = result.collection ?? [];
      if (collection.length === 0) break;

      for (const item of collection) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (!item.streamable || (item.duration ?? 0) <= 45_000) continue;
        tracks.push(scTrackToTrack(item));
        if (tracks.length >= maxTracks) break;
      }

      const next = result.next_href ? nextHrefRequest(result.next_href) : null;
      if (!next) break;
      path = next.path;
      params = next.params;
    }

    cacheSCTracks(tracks);
    return tracks;
  }

  async getArtistTracks(artistId: string, limit = 150): Promise<Track[]> {
    const maxTracks = Math.max(1, Math.min(limit, 300));
    try {
      const user = await this.getUser(artistId);
      return this.getUserTracksPaged(user.id, maxTracks);
    } catch {
      return this.getUserTracksPaged(encodeURIComponent(artistId), maxTracks);
    }
  }

  /** Get waveform data for a track (for visualization in the app) */
  async getWaveformData(trackId: string): Promise<number[]> {
    const scNumericId = trackId.replace(/^sc_/, "");
    // Check DB for waveform_url
    const db = getDb();
    const row = db
      .prepare("SELECT waveform_url FROM tracks WHERE id = $id")
      .get({ $id: trackId }) as { waveform_url: string | null } | null;

    let waveformUrl = row?.waveform_url;
    if (!waveformUrl) {
      const track = await this.apiGet<SCTrack>(`/tracks/${scNumericId}`);
      waveformUrl = track.waveform_url;
    }

    if (!waveformUrl) {
      return [];
    }

    const res = await fetch(waveformUrl, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { samples: number[]; width?: number; height?: number };
    return data.samples ?? [];
  }

  /**
   * Get trending/charts tracks.
   * kind: 'trending' | 'top'
   * genre: e.g. 'soundcloud:genres:all-music', 'soundcloud:genres:electronic', etc.
   */
  async getCharts(kind: "trending" | "top" = "trending", genre = "soundcloud:genres:all-music", limit = 20): Promise<Track[]> {
    const result = await this.apiGet<SCCollection<{ track: SCTrack }>>("/charts", {
      kind,
      genre,
      limit,
      linked_partitioning: 1,
    });
    const tracks = result.collection
      .map((item) => item.track)
      .filter((t) => t.streamable && (t.duration ?? 0) > 45000)
      .map(scTrackToTrack);

    cacheSCTracks(tracks);
    return tracks;
  }

  /**
   * Get a user's liked tracks.
   * userId can be a numeric ID or username.
   */
  async getUserLikes(userId: string, limit = 50): Promise<Track[]> {
    const isNumeric = /^\d+$/.test(userId);
    let numericId = userId;
    if (!isNumeric) {
      // Resolve username to numeric user ID
      const user = await this.apiGet<{ id: number }>("/resolve", {
        url: `https://soundcloud.com/${userId}`,
      });
      numericId = String(user.id);
    }
    const result = await this.apiGet<SCCollection<SCTrack>>(`/users/${numericId}/likes/tracks`, {
      limit,
      linked_partitioning: 1,
    });
    const tracks = result.collection.filter((t) => t.streamable && (t.duration ?? 0) > 45000).map(scTrackToTrack);
    cacheSCTracks(tracks);
    return tracks;
  }

  /** Refresh client_id manually */
  async refreshClientId(): Promise<string> {
    return getClientId(true);
  }

  /** Check if client_id is available */
  async hasClientId(): Promise<boolean> {
    try {
      const id = await getClientId();
      return !!id;
    } catch {
      return false;
    }
  }
}

let _provider: SoundCloudProvider | null = null;
export function getSoundCloudProvider(): SoundCloudProvider {
  if (!_provider) _provider = new SoundCloudProvider();
  return _provider;
}
