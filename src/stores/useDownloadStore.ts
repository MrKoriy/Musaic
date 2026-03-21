import { create } from 'zustand';
import NetInfo from '@react-native-community/netinfo';
import {
  downloadTrack,
  deleteDownload,
  deleteAllDownloads,
  getAllDownloads,
  isDownloaded,
  getDownloadRecord,
  getTotalStorageBytes,
  DownloadRecord,
} from '../services/downloadService';
import { SERVER_URL } from '../services/apiService';

interface DownloadStore {
  /** trackId → download progress 0-1 while downloading */
  activeDownloads: Record<string, number>;
  /** All persisted download records */
  downloads: DownloadRecord[];
  /** Whether the device is currently offline */
  isOffline: boolean;
  /** Total bytes used by downloads */
  totalStorageBytes: number;

  /** Start a download for a track */
  startDownload: (track: {
    id: string; title: string; artist: string; album?: string; artwork?: string; source: string;
  }) => Promise<void>;

  /** Cancel an active download (best-effort) */
  cancelDownload: (trackId: string) => void;

  /** Delete a downloaded track */
  removeDownload: (trackId: string) => Promise<void>;

  /** Delete all downloads */
  clearAllDownloads: () => Promise<void>;

  /** Refresh the list from DB */
  refreshDownloads: () => void;

  /** Check if a track is downloaded */
  isDownloaded: (trackId: string) => boolean;

  /** Get local URI for a downloaded track (or undefined if not downloaded) */
  getLocalUri: (trackId: string) => string | undefined;
}

// Single global listener — store factory runs once (Zustand singleton)
let _netInfoUnsub: (() => void) | null = null;

export const useDownloadStore = create<DownloadStore>((set, get) => {
  // Subscribe to network state changes (only once)
  if (!_netInfoUnsub) {
    _netInfoUnsub = NetInfo.addEventListener((state) => {
      set({ isOffline: !(state.isConnected ?? true) });
    });
  }

  return {
    activeDownloads: {},
    downloads: getAllDownloads(),
    isOffline: false,
    totalStorageBytes: getTotalStorageBytes(),

    startDownload: async (track) => {
      const { activeDownloads } = get();
      if (activeDownloads[track.id] !== undefined) return; // Already in progress
      if (isDownloaded(track.id)) return; // Already done

      // Mark as started
      set((s) => ({ activeDownloads: { ...s.activeDownloads, [track.id]: 0 } }));

      try {
        await downloadTrack(track, SERVER_URL, (progress) => {
          set((s) => ({ activeDownloads: { ...s.activeDownloads, [track.id]: progress } }));
        });

        // Refresh state after completion
        const downloads = getAllDownloads();
        const totalStorageBytes = getTotalStorageBytes();
        set((s) => {
          const { [track.id]: _, ...rest } = s.activeDownloads;
          return { activeDownloads: rest, downloads, totalStorageBytes };
        });
      } catch (err) {
        console.warn('[downloads] Download failed:', err);
        set((s) => {
          const { [track.id]: _, ...rest } = s.activeDownloads;
          return { activeDownloads: rest };
        });
        throw err;
      }
    },

    cancelDownload: (trackId) => {
      // Note: expo-file-system DownloadResumable doesn't easily cancel externally
      // We remove from activeDownloads so the UI reflects cancellation
      set((s) => {
        const { [trackId]: _, ...rest } = s.activeDownloads;
        return { activeDownloads: rest };
      });
    },

    removeDownload: async (trackId) => {
      await deleteDownload(trackId);
      const downloads = getAllDownloads();
      const totalStorageBytes = getTotalStorageBytes();
      set({ downloads, totalStorageBytes });
    },

    clearAllDownloads: async () => {
      await deleteAllDownloads();
      set({ downloads: [], totalStorageBytes: 0 });
    },

    refreshDownloads: () => {
      set({ downloads: getAllDownloads(), totalStorageBytes: getTotalStorageBytes() });
    },

    isDownloaded: (trackId) => isDownloaded(trackId),

    getLocalUri: (trackId) => {
      const record = getDownloadRecord(trackId);
      return record?.localUri;
    },
  };
});
