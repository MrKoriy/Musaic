import { create } from 'zustand';
import TrackPlayer from 'react-native-track-player';
import { Track, RepeatMode } from '../types';
import { appTrackToRNTP } from '../services/apiService';

interface PlayerState {
  currentTrack: Track | null;
  queue: Track[];
  queueIndex: number;
  isPlaying: boolean;
  progress: number;
  duration: number;
  repeatMode: RepeatMode;
  isShuffled: boolean;

  playTrack: (track: Track) => Promise<void>;
  setQueue: (tracks: Track[], startIndex?: number) => Promise<void>;
  addToQueue: (track: Track) => Promise<void>;
  removeFromQueue: (trackId: string) => Promise<void>;
  reorderQueue: (fromIndex: number, toIndex: number) => Promise<void>;
  setIsPlaying: (playing: boolean) => void;
  setProgress: (progress: number) => void;
  setDuration: (duration: number) => void;
  seekTo: (progress: number) => Promise<void>;
  toggleRepeat: () => void;
  toggleShuffle: () => void;
  skipNext: () => Promise<void>;
  skipPrevious: () => Promise<void>;
  clearQueue: () => Promise<void>;
  setCurrentTrackById: (id: string) => void;
  setCurrentTrack: (track: Track) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  queue: [],
  queueIndex: 0,
  isPlaying: false,
  progress: 0,
  duration: 0,
  repeatMode: 'off',
  isShuffled: false,

  playTrack: async (track) => {
    try {
      await TrackPlayer.reset();
      await TrackPlayer.add(appTrackToRNTP(track));
      await TrackPlayer.play();
      set({ queue: [track], queueIndex: 0, currentTrack: track, isPlaying: true });
    } catch (e) {
      console.warn('[player] playTrack error:', e);
      set({ queue: [track], queueIndex: 0, currentTrack: track });
    }
  },

  setQueue: async (tracks, startIndex = 0) => {
    try {
      await TrackPlayer.reset();
      await TrackPlayer.add(tracks.map(appTrackToRNTP));
      await TrackPlayer.skip(startIndex);
      await TrackPlayer.play();
      set({ queue: tracks, queueIndex: startIndex, currentTrack: tracks[startIndex] ?? null, isPlaying: true });
    } catch (e) {
      console.warn('[player] setQueue error:', e);
      set({ queue: tracks, queueIndex: startIndex, currentTrack: tracks[startIndex] ?? null });
    }
  },

  addToQueue: async (track) => {
    try {
      await TrackPlayer.add(appTrackToRNTP(track));
    } catch (e) {
      console.warn('[player] addToQueue error:', e);
    }
    set((state) => ({ queue: [...state.queue, track] }));
  },

  removeFromQueue: async (trackId) => {
    const { queue, queueIndex } = get();
    const idx = queue.findIndex((t) => t.id === trackId);
    if (idx === -1) return;
    try {
      await TrackPlayer.remove(idx);
    } catch (e) {
      console.warn('[player] removeFromQueue error:', e);
    }
    const newQueue = queue.filter((_, i) => i !== idx);
    const newIndex = idx < queueIndex
      ? queueIndex - 1
      : Math.min(queueIndex, newQueue.length - 1);
    set({
      queue: newQueue,
      queueIndex: Math.max(0, newIndex),
      currentTrack: newQueue[Math.max(0, newIndex)] ?? null,
    });
  },

  reorderQueue: async (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    const { queue, queueIndex } = get();
    try {
      await TrackPlayer.move(fromIndex, toIndex);
    } catch (e) {
      console.warn('[player] reorderQueue error:', e);
    }
    const newQueue = [...queue];
    const [moved] = newQueue.splice(fromIndex, 1);
    newQueue.splice(toIndex, 0, moved);
    let newIndex = queueIndex;
    if (fromIndex === queueIndex) newIndex = toIndex;
    else if (fromIndex < queueIndex && toIndex >= queueIndex) newIndex = queueIndex - 1;
    else if (fromIndex > queueIndex && toIndex <= queueIndex) newIndex = queueIndex + 1;
    set({ queue: newQueue, queueIndex: newIndex });
  },

  setIsPlaying: (playing) => {
    set({ isPlaying: playing });
    if (playing) TrackPlayer.play().catch(() => {});
    else TrackPlayer.pause().catch(() => {});
  },

  setProgress: (progress) => set({ progress }),
  setDuration: (duration) => set({ duration }),

  seekTo: async (progress) => {
    set({ progress });
    await TrackPlayer.seekTo(progress * get().duration);
  },

  toggleRepeat: () =>
    set((state) => {
      const modes: RepeatMode[] = ['off', 'queue', 'track'];
      return { repeatMode: modes[(modes.indexOf(state.repeatMode) + 1) % modes.length] };
    }),

  toggleShuffle: () => set((state) => ({ isShuffled: !state.isShuffled })),

  skipNext: async () => {
    try {
      await TrackPlayer.skipToNext();
    } catch {
      const { queue, queueIndex, repeatMode } = get();
      if (!queue.length) return;
      let next = queueIndex + 1;
      if (next >= queue.length) next = repeatMode === 'queue' ? 0 : queue.length - 1;
      set({ queueIndex: next, currentTrack: queue[next] });
    }
  },

  skipPrevious: async () => {
    try {
      if (get().progress * get().duration > 3) { await TrackPlayer.seekTo(0); return; }
      await TrackPlayer.skipToPrevious();
    } catch {
      const { queue, queueIndex } = get();
      if (!queue.length) return;
      const prev = Math.max(0, queueIndex - 1);
      set({ queueIndex: prev, currentTrack: queue[prev] });
    }
  },

  clearQueue: async () => {
    await TrackPlayer.reset().catch(() => {});
    set({ queue: [], queueIndex: 0, currentTrack: null });
  },

  setCurrentTrackById: (id) => {
    const { queue } = get();
    const idx = queue.findIndex((t) => t.id === id);
    if (idx !== -1) set({ queueIndex: idx, currentTrack: queue[idx] });
  },

  setCurrentTrack: (track) => set({ currentTrack: track }),
}));
