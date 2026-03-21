import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

const storage = new MMKV({ id: 'musaic-settings' });

const KEYS = {
  onboardingComplete: 'onboarding_complete',
  sourceVk: 'source_vk',
  sourceSoundcloud: 'source_soundcloud',
  vkToken: 'vk_token',
  vkAuthenticated: 'vk_authenticated',
  vkLoggedInUser: 'vk_logged_in_user',
  streamQuality: 'stream_quality',
  crossfadeSec: 'crossfade_sec',
  gapless: 'gapless',
  normalization: 'normalization',
} as const;

export type StreamQuality = 'low' | 'medium' | 'high';
export type ServerStatus = 'unknown' | 'connected' | 'disconnected';

interface SettingsState {
  onboardingComplete: boolean;
  sources: { local: boolean; vk: boolean; soundcloud: boolean };
  vkToken: string;
  vkAuthenticated: boolean;
  vkLoggedInUser: string | null;
  streamQuality: StreamQuality;
  crossfadeSec: number;
  gapless: boolean;
  normalization: boolean;
  serverStatus: ServerStatus;

  completeOnboarding: () => void;
  resetOnboarding: () => void;
  toggleSource: (source: 'local' | 'vk' | 'soundcloud') => void;
  setVkToken: (token: string) => void;
  setVkAuth: (authenticated: boolean, username: string | null) => void;
  clearVkAuth: () => void;
  setStreamQuality: (q: StreamQuality) => void;
  setCrossfadeSec: (sec: number) => void;
  setGapless: (v: boolean) => void;
  setNormalization: (v: boolean) => void;
  setServerStatus: (status: ServerStatus) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  onboardingComplete: storage.getBoolean(KEYS.onboardingComplete) ?? false,
  sources: {
    local: true,
    vk: storage.getBoolean(KEYS.sourceVk) ?? false,
    soundcloud: storage.getBoolean(KEYS.sourceSoundcloud) ?? false,
  },
  vkToken: storage.getString(KEYS.vkToken) ?? '',
  vkAuthenticated: storage.getBoolean(KEYS.vkAuthenticated) ?? false,
  vkLoggedInUser: storage.getString(KEYS.vkLoggedInUser) ?? null,
  streamQuality: (['low', 'medium', 'high'].includes(storage.getString(KEYS.streamQuality) ?? '')
    ? (storage.getString(KEYS.streamQuality) as StreamQuality)
    : 'high'),
  crossfadeSec: storage.getNumber(KEYS.crossfadeSec) ?? 0,
  gapless: storage.getBoolean(KEYS.gapless) ?? true,
  normalization: storage.getBoolean(KEYS.normalization) ?? false,
  serverStatus: 'unknown' as ServerStatus,

  completeOnboarding: () => {
    storage.set(KEYS.onboardingComplete, true);
    set({ onboardingComplete: true });
  },

  resetOnboarding: () => {
    storage.set(KEYS.onboardingComplete, false);
    set({ onboardingComplete: false });
  },

  toggleSource: (source) =>
    set((state) => {
      const next = { ...state.sources, [source]: !state.sources[source] };
      if (source === 'vk') storage.set(KEYS.sourceVk, next.vk);
      if (source === 'soundcloud') storage.set(KEYS.sourceSoundcloud, next.soundcloud);
      return { sources: next };
    }),

  setVkToken: (token) => {
    storage.set(KEYS.vkToken, token);
    set({ vkToken: token });
  },

  setVkAuth: (authenticated, username) => {
    storage.set(KEYS.vkAuthenticated, authenticated);
    if (username) storage.set(KEYS.vkLoggedInUser, username);
    else storage.delete(KEYS.vkLoggedInUser);
    set({ vkAuthenticated: authenticated, vkLoggedInUser: username });
  },

  clearVkAuth: () => {
    storage.delete(KEYS.vkAuthenticated);
    storage.delete(KEYS.vkLoggedInUser);
    set({ vkAuthenticated: false, vkLoggedInUser: null });
  },

  setStreamQuality: (q) => {
    storage.set(KEYS.streamQuality, q);
    set({ streamQuality: q });
  },

  setCrossfadeSec: (sec) => {
    storage.set(KEYS.crossfadeSec, sec);
    set({ crossfadeSec: sec });
  },

  setGapless: (v) => {
    storage.set(KEYS.gapless, v);
    set({ gapless: v });
  },

  setNormalization: (v) => {
    storage.set(KEYS.normalization, v);
    set({ normalization: v });
  },

  setServerStatus: (status) => set({ serverStatus: status }),
}));
