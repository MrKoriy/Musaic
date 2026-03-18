import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

const storage = new MMKV({ id: 'musaic-settings' });

const KEYS = {
  onboardingComplete: 'onboarding_complete',
  sourceVk: 'source_vk',
  sourceSoundcloud: 'source_soundcloud',
} as const;

interface SettingsState {
  onboardingComplete: boolean;
  sources: { local: boolean; vk: boolean; soundcloud: boolean };

  completeOnboarding: () => void;
  resetOnboarding: () => void;
  toggleSource: (source: 'local' | 'vk' | 'soundcloud') => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  onboardingComplete: storage.getBoolean(KEYS.onboardingComplete) ?? false,
  sources: {
    local: true,
    vk: storage.getBoolean(KEYS.sourceVk) ?? false,
    soundcloud: storage.getBoolean(KEYS.sourceSoundcloud) ?? false,
  },

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
}));
