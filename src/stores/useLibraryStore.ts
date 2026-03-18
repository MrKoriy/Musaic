import { create } from 'zustand';
import { Track, Playlist } from '../types';

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
  playlists: [],
  likedTrackIds: new Set(),

  setTracks: (tracks) => set({ tracks }),

  addTrack: (track) =>
    set((state) => ({
      tracks: state.tracks.some((t) => t.id === track.id)
        ? state.tracks
        : [...state.tracks, track],
    })),

  removeTrack: (trackId) =>
    set((state) => ({ tracks: state.tracks.filter((t) => t.id !== trackId) })),

  setPlaylists: (playlists) => set({ playlists }),

  createPlaylist: (name) => {
    const playlist: Playlist = {
      id: `playlist_${Date.now()}`,
      name,
      tracks: [],
      createdAt: Date.now(),
    };
    set((state) => ({ playlists: [...state.playlists, playlist] }));
    return playlist;
  },

  addToPlaylist: (playlistId, track) =>
    set((state) => ({
      playlists: state.playlists.map((p) =>
        p.id === playlistId && !p.tracks.some((t) => t.id === track.id)
          ? { ...p, tracks: [...p.tracks, track] }
          : p
      ),
    })),

  removeFromPlaylist: (playlistId, trackId) =>
    set((state) => ({
      playlists: state.playlists.map((p) =>
        p.id === playlistId
          ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) }
          : p
      ),
    })),

  deletePlaylist: (playlistId) =>
    set((state) => ({
      playlists: state.playlists.filter((p) => p.id !== playlistId),
    })),

  toggleLike: (trackId) =>
    set((state) => {
      const next = new Set(state.likedTrackIds);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return { likedTrackIds: next };
    }),

  isLiked: (trackId) => get().likedTrackIds.has(trackId),
}));
