import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';
import { Track, Playlist } from '../types';

const storage = new MMKV({ id: 'musaic-library' });

const KEYS = {
  likedTrackIds: 'liked_track_ids',
  playlists: 'playlists',
} as const;

function loadLikedTrackIds(): Set<string> {
  try {
    const raw = storage.getString(KEYS.likedTrackIds);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {}
  return new Set();
}

function loadPlaylists(): Playlist[] {
  try {
    const raw = storage.getString(KEYS.playlists);
    if (raw) return JSON.parse(raw) as Playlist[];
  } catch {}
  return [];
}

interface LibraryState {
  tracks: Track[];
  playlists: Playlist[];
  likedTrackIds: Set<string>;

  // Actions
  setTracks: (tracks: Track[]) => void;
  addTrack: (track: Track) => void;
  removeTrack: (trackId: string) => void;
  setPlaylists: (playlists: Playlist[]) => void;
  createPlaylist: (name: string) => Playlist;
  addToPlaylist: (playlistId: string, track: Track) => void;
  removeFromPlaylist: (playlistId: string, trackId: string) => void;
  deletePlaylist: (playlistId: string) => void;
  toggleLike: (trackId: string) => void;
  isLiked: (trackId: string) => boolean;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  playlists: loadPlaylists(),
  likedTrackIds: loadLikedTrackIds(),

  setTracks: (tracks) => set({ tracks }),

  addTrack: (track) =>
    set((state) => ({
      tracks: state.tracks.some((t) => t.id === track.id)
        ? state.tracks
        : [...state.tracks, track],
    })),

  removeTrack: (trackId) =>
    set((state) => ({ tracks: state.tracks.filter((t) => t.id !== trackId) })),

  setPlaylists: (playlists) => {
    storage.set(KEYS.playlists, JSON.stringify(playlists));
    set({ playlists });
  },

  createPlaylist: (name) => {
    const playlist: Playlist = {
      id: `playlist_${Date.now()}`,
      name,
      tracks: [],
      createdAt: Date.now(),
    };
    set((state) => {
      const playlists = [...state.playlists, playlist];
      storage.set(KEYS.playlists, JSON.stringify(playlists));
      return { playlists };
    });
    return playlist;
  },

  addToPlaylist: (playlistId, track) =>
    set((state) => {
      const playlists = state.playlists.map((p) =>
        p.id === playlistId && !p.tracks.some((t) => t.id === track.id)
          ? { ...p, tracks: [...p.tracks, track] }
          : p
      );
      storage.set(KEYS.playlists, JSON.stringify(playlists));
      return { playlists };
    }),

  removeFromPlaylist: (playlistId, trackId) =>
    set((state) => {
      const playlists = state.playlists.map((p) =>
        p.id === playlistId
          ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) }
          : p
      );
      storage.set(KEYS.playlists, JSON.stringify(playlists));
      return { playlists };
    }),

  deletePlaylist: (playlistId) =>
    set((state) => {
      const playlists = state.playlists.filter((p) => p.id !== playlistId);
      storage.set(KEYS.playlists, JSON.stringify(playlists));
      return { playlists };
    }),

  toggleLike: (trackId) =>
    set((state) => {
      const next = new Set(state.likedTrackIds);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      storage.set(KEYS.likedTrackIds, JSON.stringify([...next]));
      return { likedTrackIds: next };
    }),

  isLiked: (trackId) => get().likedTrackIds.has(trackId),
}));
