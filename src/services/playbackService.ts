import TrackPlayer, { Event, State, Capability, AppKilledPlaybackBehavior, useTrackPlayerEvents, useProgress } from 'react-native-track-player';
import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../stores/usePlayerStore';
import { api } from './apiService';

export async function PlaybackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) =>
    TrackPlayer.seekTo(position)
  );
  // Handle audio interruptions (phone calls, other apps) — Android audio focus + iOS interruptions
  TrackPlayer.addEventListener(Event.RemoteDuck, async ({ permanent, paused }) => {
    if (permanent) {
      await TrackPlayer.stop();
    } else if (paused) {
      await TrackPlayer.pause();
    } else {
      await TrackPlayer.play();
    }
  });
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
      // Update lock screen progress every second
      progressUpdateEventInterval: 1,
      // Keep notification visible when app is killed on Android
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
    });
  } catch (error) {
    // Player may already be initialized (hot reload)
    console.log('TrackPlayer setup skipped:', error);
  }
}

/**
 * Hook — sync RNTP state → Zustand store + scrobble listening history.
 * Call once at the root of the app (inside NavigationContainer).
 */
export function useRNTPSync() {
  const { setIsPlaying, setProgress, setDuration, setCurrentTrackById } = usePlayerStore();
  // Track the last scrobbled ID to avoid duplicate scrobbles on re-renders
  const lastScrobbledId = useRef<string | null>(null);

  const progress = useProgress(500); // update every 500ms

  useEffect(() => {
    const { position, duration } = progress;
    setProgress(duration > 0 ? position / duration : 0);
    setDuration(duration);

    // Scrobble "complete" when track reaches 90%+ of duration
    const ratio = duration > 0 ? position / duration : 0;
    const { currentTrack } = usePlayerStore.getState();
    if (ratio >= 0.9 && currentTrack && lastScrobbledId.current !== `complete-${currentTrack.id}`) {
      lastScrobbledId.current = `complete-${currentTrack.id}`;
      api.scrobble(currentTrack.id, 'complete');
      api.logPlay(currentTrack.id, 'complete');
    }
  }, [progress]);

  useTrackPlayerEvents([Event.PlaybackState], ({ state }) => {
    setIsPlaying(state === State.Playing);
  });

  useTrackPlayerEvents([Event.PlaybackActiveTrackChanged], async ({ track }) => {
    if (track?.id) {
      const trackId = track.id;
      setCurrentTrackById(trackId);

      // Scrobble play event for new track (avoid duplicate on same track)
      if (lastScrobbledId.current !== `play-${trackId}`) {
        lastScrobbledId.current = `play-${trackId}`;
        api.scrobble(trackId, 'play');
        api.logPlay(trackId, 'play');
      }
    }
  });
}
