import TrackPlayer, { Event, State, Capability, RepeatMode, AppKilledPlaybackBehavior, useTrackPlayerEvents, useProgress } from 'react-native-track-player';
import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useSettingsStore } from '../stores/useSettingsStore';
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

  // Auto-advance: when queue ends, loop back to start if repeat is 'queue'
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, async ({ position }) => {
    const { repeatMode, queue } = usePlayerStore.getState();
    if (repeatMode === 'queue' && queue.length > 0) {
      await TrackPlayer.skip(0);
      await TrackPlayer.play();
    }
  });

  // Surface playback errors — retry once, then stop to avoid silent garbage-audio loop
  const retried = new Set<string>();
  TrackPlayer.addEventListener(Event.PlaybackError, async ({ message, code }) => {
    console.error('[player] PlaybackError', code, message);
    try {
      const track = await TrackPlayer.getActiveTrack();
      const trackId = track?.id;
      if (trackId && !retried.has(trackId)) {
        retried.add(trackId);
        await new Promise((r) => setTimeout(r, 1500));
        await TrackPlayer.retry();
      } else {
        await TrackPlayer.stop();
      }
    } catch {
      await TrackPlayer.stop().catch(() => {});
    }
  });

  // Clear retried set when track changes successfully (prevent unbounded growth)
  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, () => {
    if (retried.size > 50) retried.clear();
  });
}

export async function setupPlayer() {
  try {
    await TrackPlayer.setupPlayer({
      maxCacheSize: 1024 * 50, // 50MB cache
      // HLS / network stream buffering
      minBuffer: 15,        // seconds to buffer before playback starts
      maxBuffer: 50,        // max seconds to keep buffered
      backBuffer: 30,       // seconds to keep behind current position
      playBuffer: 2.5,      // seconds needed to resume after rebuffer
    });

    // Default to 'off' — auto-advance through queue, stop at end
    await TrackPlayer.setRepeatMode(RepeatMode.Off);

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
  const setServerStatus = useSettingsStore((s) => s.setServerStatus);
  // Track the last scrobbled ID to avoid duplicate scrobbles on re-renders
  const lastScrobbledId = useRef<string | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Global server health check — runs once, independent of tab navigation
  useEffect(() => {
    const checkServer = async () => {
      const ok = await api.ping();
      setServerStatus(ok ? 'connected' : 'disconnected');
    };
    checkServer();
    pingRef.current = setInterval(checkServer, 60_000);
    return () => { if (pingRef.current) clearInterval(pingRef.current); };
  }, []);

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
        api.logPlay(trackId, 'play');
      }
    }
  });
}
