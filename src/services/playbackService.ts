import TrackPlayer, { Event, State, Capability, useTrackPlayerEvents, useProgress } from 'react-native-track-player';
import { useEffect } from 'react';
import { usePlayerStore } from '../stores/usePlayerStore';

export async function PlaybackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) =>
    TrackPlayer.seekTo(position)
  );
}

export async function setupPlayer() {
  try {
    await TrackPlayer.setupPlayer({
      maxCacheSize: 1024 * 50, // 50MB cache
    });

    await TrackPlayer.updateOptions({
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
        Capability.Stop,
        Capability.SeekTo,
      ],
      compactCapabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
      notificationCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],
    });
  } catch (error) {
    // Player may already be initialized (hot reload)
    console.log('TrackPlayer setup skipped:', error);
  }
}

/**
 * Hook — sync RNTP state → Zustand store.
 * Call once at the root of the app (inside NavigationContainer).
 */
export function useRNTPSync() {
  const { setIsPlaying, setProgress, setDuration, setCurrentTrackById } = usePlayerStore();

  const progress = useProgress(500); // update every 500ms

  useEffect(() => {
    const { position, duration } = progress;
    setProgress(duration > 0 ? position / duration : 0);
    setDuration(duration);
  }, [progress]);

  useTrackPlayerEvents([Event.PlaybackState], ({ state }) => {
    setIsPlaying(state === State.Playing);
  });

  useTrackPlayerEvents([Event.PlaybackActiveTrackChanged], async ({ track }) => {
    if (track?.id) {
      setCurrentTrackById(track.id as string);
    }
  });
}
