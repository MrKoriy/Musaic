/**
 * API Service — HTTP client for the Musaic server.
 *
 * URL resolution: user-configured IP (MMKV) → production server fallback.
 */
import { MMKV } from 'react-native-mmkv';

const storage = new MMKV({ id: 'musaic-settings' });
const STORED_SERVER_URL_KEY = 'server_url';
const PRODUCTION_SERVER = 'http://45.146.167.109:3001';

function detectServerUrl(): string {
  return storage.getString(STORED_SERVER_URL_KEY) ?? PRODUCTION_SERVER;
}

export let SERVER_URL = detectServerUrl();

/** Persist a custom server URL and apply it immediately. */
export function setServerUrl(url: string) {
  SERVER_URL = url.replace(/\/$/, '');
  storage.set(STORED_SERVER_URL_KEY, SERVER_URL);
}

/** Clear the stored URL and reset to the production server. */
export function clearServerUrl() {
  storage.delete(STORED_SERVER_URL_KEY);
  SERVER_URL = PRODUCTION_SERVER;
}

/** Returns the user-stored server URL, or undefined if not configured. */
export function getStoredServerUrl(): string | undefined {
  return storage.getString(STORED_SERVER_URL_KEY);
}

/** Extract a human-readable error message from a failed response */
async function extractError(method: string, path: string, res: Response): Promise<Error> {
  let detail = '';
  try {
    const body = await res.json() as { error?: string; message?: string };
    detail = body.error ?? body.message ?? '';
  } catch {
    try { detail = await res.text(); } catch {}
  }
  const msg = detail ? `${method} ${path} ${res.status}: ${detail}` : `${method} ${path} failed: ${res.status}`;
  return new Error(msg);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`);
  if (!res.ok) throw await extractError('GET', path, res);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await extractError('POST', path, res);
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, { method: 'DELETE' });
  if (!res.ok) throw await extractError('DELETE', path, res);
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await extractError('PATCH', path, res);
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
  // camelCase variants returned by some endpoints (search)
  coverUrl?: string;
  streamUrl?: string;
  localPath?: string;
  waveformUrl?: string;
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
      await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(5000) });
      return true;
    } catch (e) {
      console.warn('[Musaic] ping failed:', SERVER_URL, e instanceof Error ? e.message : String(e));
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

  searchTracks(query: string, sources = 'local', limit = 30, offset = 0) {
    return get<{ tracks: ServerTrack[]; bySource: Record<string, ServerTrack[]> }>(
      `/api/search?q=${encodeURIComponent(query)}&sources=${sources}&limit=${limit}&offset=${offset}`
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

  updatePlaylist(id: string, data: { name?: string; description?: string }) {
    return patch<{ ok: boolean }>(`/api/playlists/${id}`, data);
  },

  getPlaylistCovers(playlistId: string) {
    return get<{ covers: string[] }>(`/api/playlists/${playlistId}/cover`);
  },

  // Smart Playlists
  generateSmartPlaylist(opts: {
    name?: string;
    rules?: Array<{ field: string; op: string; value: string | number }>;
    limit?: number;
    sort?: string;
    sortDir?: 'ASC' | 'DESC';
    save?: boolean;
  }) {
    return post<{ tracks: ServerTrack[]; count: number; playlistId?: string }>(
      '/api/smart-playlists/generate',
      opts
    );
  },

  generateAIPlaylist(opts: { prompt: string; limit?: number; save?: boolean }) {
    return post<{ tracks: ServerTrack[]; count: number; name: string; playlistId?: string }>(
      '/api/smart-playlists/ai',
      opts
    );
  },

  importPlaylist(opts: { name?: string; text?: string; lines?: string[]; save?: boolean }) {
    return post<{ matched: Array<{ input: string; track: ServerTrack }>; unmatched: string[]; count: number; playlistId?: string }>(
      '/api/smart-playlists/import',
      opts
    );
  },

  getDuplicates(playlistId?: string) {
    const q = playlistId ? `?playlistId=${encodeURIComponent(playlistId)}` : '';
    return get<{ duplicates: ServerTrack[] }>(`/api/smart-playlists/duplicates${q}`);
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

  getDailyMix(refresh = false) {
    return get<{ name: string; tracks: ServerTrack[]; source: string; refreshAt: string }>(
      `/api/recommendations/daily-mix${refresh ? '?refresh=1' : ''}`
    );
  },

  getDiscover() {
    return get<{ tracks: ServerTrack[]; source: string; description: string }>(
      '/api/recommendations/discover'
    );
  },

  getMoodTracks(mood: string, limit = 20) {
    return get<{ tracks: ServerTrack[]; mood: string; count: number }>(
      `/api/recommendations/mood?mood=${encodeURIComponent(mood)}&limit=${limit}`
    );
  },

  chatWithAI(message: string, history: Array<{ role: string; content: string }> = []) {
    return post<{ reply: string; error?: string }>(
      '/api/recommendations/chat',
      { message, history }
    );
  },

  // VK Auth
  async vkLogin(username: string, password: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${SERVER_URL}/api/vk/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json() as { ok?: boolean; error?: string; requires2FA?: boolean };
    if (!res.ok) {
      const err: Error & { requires2FA?: boolean } = new Error(data.error ?? `VK login failed: ${res.status}`);
      err.requires2FA = data.requires2FA ?? false;
      throw err;
    }
    return { ok: true };
  },

  vkSetToken(token: string, username?: string) {
    return post<{ ok: boolean }>('/api/vk/auth-token', { token, username });
  },

  vkLogout() {
    return post<{ ok: boolean }>('/api/vk/logout', {});
  },

  vkMe() {
    return get<{ authenticated: boolean; username: string | null }>('/api/vk/me');
  },

  vkPlaylists(offset = 0, count = 50) {
    return get<{ playlists: Array<{ id: number; owner_id: number; title: string; description?: string; count: number; photo?: { photo_270?: string } }> }>(
      `/api/vk/playlists?offset=${offset}&count=${count}`
    );
  },

  vkPlaylistTracks(playlistId: number, ownerId?: number) {
    const q = ownerId !== undefined ? `?ownerId=${ownerId}` : '';
    return get<{ tracks: Array<{ id: string; title: string; artist: string; album?: string; duration: number; coverUrl?: string }> }>(
      `/api/vk/playlists/${playlistId}/tracks${q}`
    );
  },

  scrobble(trackId: string, action: 'play' | 'complete' | 'skip' = 'play') {
    return post<{ ok: boolean }>('/api/recommendations/scrobble', { trackId, action }).catch(() => {});
  },

  // Stats
  getStatsOverview() {
    return get<{
      listens: { today: number; week: number; month: number; allTime: number };
      listeningTime: { todaySecs: number; weekSecs: number; monthSecs: number; allTimeSecs: number };
      streak: number;
      topTrack: { track_id: string; title: string; artist: string; play_count: number } | null;
      topArtist: { artist: string; play_count: number } | null;
    }>('/api/stats/overview');
  },

  getTopTracks(period: 'today' | 'week' | 'month' | 'alltime' = 'alltime', limit = 20) {
    return get<{ tracks: Array<{ track_id: string; title: string; artist: string; album: string | null; cover_url: string | null; duration: number; play_count: number }> }>(
      `/api/stats/top-tracks?period=${period}&limit=${limit}`
    );
  },

  getTopArtists(period: 'today' | 'week' | 'month' | 'alltime' = 'alltime') {
    return get<{ artists: Array<{ artist: string; play_count: number; unique_tracks: number; cover_url: string | null }> }>(
      `/api/stats/top-artists?period=${period}`
    );
  },

  getTopAlbums(period: 'today' | 'week' | 'month' | 'alltime' = 'alltime') {
    return get<{ albums: Array<{ album: string; artist: string; play_count: number; cover_url: string | null }> }>(
      `/api/stats/top-albums?period=${period}`
    );
  },

  getListeningHeatmap(period: 'week' | 'month' | 'alltime' = 'month') {
    return get<{ heatmap: Array<{ hour: number; play_count: number }> }>(
      `/api/stats/heatmap?period=${period}`
    );
  },

  getGenreStats(period: 'today' | 'week' | 'month' | 'alltime' = 'alltime') {
    return get<{ genres: Array<{ genre: string; play_count: number; percentage: number }> }>(
      `/api/stats/genres?period=${period}`
    );
  },
};

/** Get the playback URL for a track based on its source */
function trackPlaybackUrl(track: ServerTrack): string {
  if (track.source === 'soundcloud') {
    // Use server proxy — server resolves SC stream URL and redirects
    return `${SERVER_URL}/api/sc/proxy/${encodeURIComponent(track.id)}`;
  }
  if (track.source === 'vk') {
    // Downloaded tracks: serve from local file
    if (track.local_path) {
      return `${SERVER_URL}/audio/local/${encodeURIComponent(track.id)}`;
    }
    // Use VK proxy so server auto-refreshes expired IP-bound URLs (23h TTL)
    return `${SERVER_URL}/api/vk/proxy/${encodeURIComponent(track.id)}`;
  }
  return `${SERVER_URL}/audio/local/${encodeURIComponent(track.id)}`;
}

/** Resolve a server-relative URL to absolute (http URLs pass through). */
export function resolveServerUrl(url: string): string {
  return url.startsWith('http') ? url : `${SERVER_URL}${url}`;
}

/** Resolve artwork URL (absolute SC URLs pass through; local paths get prefixed) */
function resolveArtwork(track: ServerTrack): string | undefined {
  const url = track.cover_url ?? track.coverUrl;
  if (!url) return undefined;
  return resolveServerUrl(url);
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

/** Convert the app's Track type to a react-native-track-player Track shape */
export function appTrackToRNTP(track: import('../types').Track): import('react-native-track-player').Track {
  return {
    id: track.id,
    url: track.url,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    artwork: track.artwork,
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
  source: 'lrclib' | 'genius' | 'lyricsovh' | 'ai' | 'manual' | null;
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
  if (!res.ok) throw await extractError('PUT', path, res);
  return res.json() as Promise<T>;
}
