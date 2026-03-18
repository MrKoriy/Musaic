/**
 * API Service — HTTP client for the local Musaic Bun server.
 *
 * URL resolution priority:
 *  1. User-configured IP (stored in MMKV)
 *  2. Auto-detected from Metro bundler scriptURL (LAN IP on physical device)
 *  3. Platform fallback (Android emulator / localhost)
 */
import { NativeModules, Platform } from 'react-native';
import { MMKV } from 'react-native-mmkv';

const storage = new MMKV({ id: 'musaic-settings' });
const STORED_SERVER_URL_KEY = 'server_url';
const PORT = 3001;

function detectServerUrlAutomatic(): string {
  if (__DEV__) {
    // Metro bundler's scriptURL looks like "http://192.168.x.x:8081/index.bundle?..."
    const scriptURL: string | undefined =
      NativeModules?.SourceCode?.scriptURL ??
      NativeModules?.SourceCode?.getConstants?.()?.scriptURL;
    if (scriptURL) {
      const match = scriptURL.match(/^https?:\/\/([^:\/]+)/);
      if (match && match[1] !== 'localhost' && match[1] !== '127.0.0.1') {
        return `http://${match[1]}:${PORT}`;
      }
    }
  }
  // Fallback: Android emulator uses 10.0.2.2 for host loopback
  if (Platform.OS === 'android') return `http://10.0.2.2:${PORT}`;
  return `http://localhost:${PORT}`;
}

function detectServerUrl(): string {
  const stored = storage.getString(STORED_SERVER_URL_KEY);
  if (stored) return stored;
  return detectServerUrlAutomatic();
}

export let SERVER_URL = detectServerUrl();

/** Persist a custom server URL and apply it immediately. */
export function setServerUrl(url: string) {
  SERVER_URL = url.replace(/\/$/, '');
  storage.set(STORED_SERVER_URL_KEY, SERVER_URL);
}

/** Clear the stored URL and fall back to auto-detection. */
export function clearServerUrl() {
  storage.delete(STORED_SERVER_URL_KEY);
  SERVER_URL = detectServerUrlAutomatic();
}

/** Returns the user-stored server URL, or undefined if not configured. */
export function getStoredServerUrl(): string | undefined {
  return storage.getString(STORED_SERVER_URL_KEY);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// ─── Track types matching server schema ──────────────────────────────────────

export interface ServerTrack {
  id: string;
  source: 'local' | 'vk' | 'soundcloud';
  title: string;
  artist: string;
  album?: string;
  duration: number;
  cover_url?: string;
  local_path?: string;
  waveform_url?: string;
  metadata?: string; // JSON string
}

export interface ServerAlbum {
  album: string;
  artist: string;
  track_count: number;
  cover_url?: string;
  source?: string;
}

export interface ServerArtist {
  artist: string;
  track_count: number;
  album_count: number;
  cover_url?: string;
}

export interface ServerPlaylist {
  id: string;
  name: string;
  description?: string;
  track_count: number;
  created_at: number;
  updated_at: number;
}

// ─── API methods ──────────────────────────────────────────────────────────────

export const api = {
  /** Health check — returns true if server is reachable */
  async ping(): Promise<boolean> {
    try {
      await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  },

  // Tracks
  getTracks(params: { source?: string; limit?: number; offset?: number } = {}) {
    const q = new URLSearchParams();
    if (params.source) q.set('source', params.source);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    return get<{ tracks: ServerTrack[] }>(`/api/tracks?${q}`);
  },

  searchTracks(query: string, sources = 'local') {
    return get<{ tracks: ServerTrack[]; bySource: Record<string, ServerTrack[]> }>(
      `/api/search?q=${encodeURIComponent(query)}&sources=${sources}`
    );
  },

  /** Returns the full stream URL for a local track */
  getStreamUrl(trackId: string) {
    return `${SERVER_URL}/audio/local/${encodeURIComponent(trackId)}`;
  },

  // Local library
  scanFolder(dir: string) {
    return post<{ ok: boolean; message: string }>('/api/local/scan', { dir });
  },

  getScanStatus() {
    return get<{ scanning: boolean; scanned: number; total: number; indexedTracks: number }>(
      '/api/local/status'
    );
  },

  // Albums
  getAlbums(source?: string) {
    const q = source ? `?source=${source}` : '';
    return get<{ albums: ServerAlbum[] }>(`/api/albums${q}`);
  },

  getAlbumTracks(album: string, artist?: string) {
    const q = new URLSearchParams({ album });
    if (artist) q.set('artist', artist);
    return get<{ tracks: ServerTrack[] }>(`/api/albums/tracks?${q}`);
  },

  // Artists
  getArtists(source?: string) {
    const q = source ? `?source=${source}` : '';
    return get<{ artists: ServerArtist[] }>(`/api/artists${q}`);
  },

  // Playlists
  getPlaylists() {
    return get<{ playlists: ServerPlaylist[] }>('/api/playlists');
  },

  createPlaylist(name: string, description?: string) {
    return post<{ ok: boolean; id: string }>('/api/playlists', { name, description });
  },

  deletePlaylist(id: string) {
    return del<{ ok: boolean }>(`/api/playlists/${id}`);
  },

  getPlaylistTracks(playlistId: string) {
    return get<{ tracks: ServerTrack[] }>(`/api/playlists/${playlistId}/tracks`);
  },

  addToPlaylist(playlistId: string, trackId: string) {
    return post<{ ok: boolean }>(`/api/playlists/${playlistId}/tracks`, { trackId });
  },

  removeFromPlaylist(playlistId: string, trackId: string) {
    return del<{ ok: boolean }>(`/api/playlists/${playlistId}/tracks/${trackId}`);
  },

  // History
  logPlay(trackId: string, action: 'play' | 'pause' | 'skip' | 'complete' = 'play') {
    return post<{ ok: boolean }>('/api/history', { trackId, action }).catch(() => {
      // Silently fail — don't block playback if history fails
    });
  },

  // AI Recommendations
  getTasteProfile() {
    return get<{ topArtists: string[]; topTracks: Array<{ artist: string; title: string }>; playCount: number }>(
      '/api/recommendations/taste-profile'
    );
  },

  getSimilarTracks(artist: string, track: string) {
    return get<{ tracks: ServerTrack[]; similar: Array<{ artist: string; track: string }> }>(
      `/api/recommendations/similar?artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}`
    );
  },

  getHomeRecommendations() {
    return get<{ tracks: ServerTrack[]; profile: unknown; source: string }>(
      '/api/recommendations/home'
    );
  },

  chatWithAI(message: string, history: Array<{ role: string; content: string }> = []) {
    return post<{ reply: string; error?: string }>(
      '/api/recommendations/chat',
      { message, history }
    );
  },

  scrobble(trackId: string, action: 'play' | 'complete' | 'skip' = 'play') {
    return post<{ ok: boolean }>('/api/recommendations/scrobble', { trackId, action }).catch(() => {});
  },
};

/** Get the playback URL for a track based on its source */
function trackPlaybackUrl(track: ServerTrack): string {
  if (track.source === 'soundcloud') {
    // Use server proxy — server resolves SC stream URL and redirects
    return `${SERVER_URL}/api/sc/proxy/${encodeURIComponent(track.id)}`;
  }
  if (track.source === 'vk' && track.local_path) {
    return `${SERVER_URL}/audio/local/${encodeURIComponent(track.id)}`;
  }
  return `${SERVER_URL}/audio/local/${encodeURIComponent(track.id)}`;
}

/** Resolve artwork URL (absolute SC URLs pass through; local paths get prefixed) */
function resolveArtwork(track: ServerTrack): string | undefined {
  if (!track.cover_url) return undefined;
  if (track.cover_url.startsWith('http')) return track.cover_url;
  return `${SERVER_URL}${track.cover_url}`;
}

/** Convert a ServerTrack to a react-native-track-player Track shape */
export function serverTrackToRNTP(track: ServerTrack): import('react-native-track-player').Track {
  return {
    id: track.id,
    url: trackPlaybackUrl(track),
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    artwork: resolveArtwork(track),
  };
}

/** Convert a ServerTrack to the app's Track type */
export function serverTrackToAppTrack(track: ServerTrack): import('../types').Track {
  return {
    id: track.id,
    source: track.source,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    artwork: resolveArtwork(track),
    url: trackPlaybackUrl(track),
  };
}

/** Fetch SoundCloud waveform samples for visualization */
export function getSCWaveform(trackId: string): Promise<{ samples: number[] }> {
  return get<{ samples: number[] }>(`/api/sc/waveform/${encodeURIComponent(trackId)}`);
}

// ─── Lyrics API ───────────────────────────────────────────────────────────────

export interface LyricsResult {
  trackId: string;
  lrc: string | null;
  source: 'lrclib' | 'ai' | 'manual' | null;
  cached: boolean;
}

export interface LyricsJobStatus {
  trackId: string;
  status: 'not_started' | 'running' | 'done' | 'failed';
  startedAt?: number;
  error?: string;
  cached?: boolean;
}

/** Fetch lyrics for a track (LRCLIB first, then cache). */
export function getLyrics(
  trackId: string,
  opts: { artist?: string; title?: string; duration?: number } = {}
): Promise<LyricsResult> {
  const q = new URLSearchParams();
  if (opts.artist) q.set('artist', opts.artist);
  if (opts.title) q.set('title', opts.title);
  if (opts.duration) q.set('duration', String(opts.duration));
  const qs = q.toString();
  return get<LyricsResult>(`/api/lyrics/${encodeURIComponent(trackId)}${qs ? `?${qs}` : ''}`);
}

/** Start AI transcription pipeline for a track (async, poll status). */
export function generateLyrics(trackId: string, audioPath?: string): Promise<LyricsJobStatus> {
  return post<LyricsJobStatus>(`/api/lyrics/${encodeURIComponent(trackId)}/generate`, { audioPath });
}

/** Poll AI job status. */
export function getLyricsJobStatus(trackId: string): Promise<LyricsJobStatus> {
  return get<LyricsJobStatus>(`/api/lyrics/${encodeURIComponent(trackId)}/status`);
}

/** Save manually edited lyrics. */
export function saveLyrics(trackId: string, lrc: string): Promise<{ ok: boolean }> {
  return put<{ ok: boolean }>(`/api/lyrics/${encodeURIComponent(trackId)}`, { lrc });
}

/** Trigger online artwork lookup for a track that has no embedded cover. */
export function fetchTrackArtwork(
  trackId: string
): Promise<{ ok: boolean; url?: string; source?: string; message?: string }> {
  return get<{ ok: boolean; url?: string; source?: string; message?: string }>(
    `/api/covers/${encodeURIComponent(trackId)}/fetch`
  );
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}
