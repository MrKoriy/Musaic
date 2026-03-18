/**
 * API Service — HTTP client for the local Musaic Bun server.
 *
 * Default base URL: http://localhost:3001
 * Change SERVER_URL to your Mac's local IP when testing on a real device.
 */

export let SERVER_URL = 'http://localhost:3001';

export function setServerUrl(url: string) {
  SERVER_URL = url.replace(/\/$/, '');
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
};

/** Convert a ServerTrack to a react-native-track-player Track shape */
export function serverTrackToRNTP(track: ServerTrack): import('react-native-track-player').Track {
  return {
    id: track.id,
    url: `${SERVER_URL}/audio/local/${encodeURIComponent(track.id)}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    artwork: track.cover_url ? `${SERVER_URL}${track.cover_url}` : undefined,
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
    artwork: track.cover_url ? `${SERVER_URL}${track.cover_url}` : undefined,
    url: `${SERVER_URL}/audio/local/${encodeURIComponent(track.id)}`,
  };
}
