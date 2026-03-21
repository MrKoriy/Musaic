import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  Dimensions, PanResponder, Modal, SafeAreaView, StatusBar,
} from 'react-native';
import {
  ChevronDown, Play, Pause, SkipBack, SkipForward,
  Shuffle, Repeat, Repeat1, AlignJustify, Mic2, Moon,
} from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { HeartButton } from '../components/HeartButton';
import { WaveformBar } from '../components/WaveformBar';
import { LyricsView } from '../components/LyricsView';
import { QueueSheet } from '../components/QueueSheet';
import { AlbumArtCarousel } from '../components/AlbumArtCarousel';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import { formatDuration } from '../data/mockData';
import TrackPlayer from 'react-native-track-player';
import { haptics } from '../utils/haptics';

const { width: W, height: H } = Dimensions.get('window');
const ART_SIZE = Math.min(W - 48, 380);
const DISMISS_THRESHOLD = 80;

function formatSleepCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function NowPlayingScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [showLyrics, setShowLyrics] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [sleepRemaining, setSleepRemaining] = useState(0);

  const {
    currentTrack, isPlaying, progress, duration,
    togglePlayPause, skipNext, skipPrevious, seekTo,
    repeatMode, isShuffled, toggleRepeat, toggleShuffle,
    sleepTimerEndsAt, setSleepTimer,
  } = usePlayerStore();
  const { isLiked, toggleLike } = useLibraryStore();

  // ── Swipe-down to dismiss ──────────────────────────────────────────
  const dismissY = useRef(new Animated.Value(0)).current;
  const dismissOpacity = useRef(new Animated.Value(1)).current;

  const dismissPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) =>
        gs.dy > 12 && Math.abs(gs.dy) > Math.abs(gs.dx),
      onPanResponderMove: (_, gs) => {
        if (gs.dy > 0) {
          dismissY.setValue(gs.dy);
          dismissOpacity.setValue(Math.max(0.3, 1 - gs.dy / (H * 0.5)));
        }
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > DISMISS_THRESHOLD || gs.vy > 0.8) {
          Animated.parallel([
            Animated.timing(dismissY, { toValue: H, duration: 250, useNativeDriver: true }),
            Animated.timing(dismissOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
          ]).start(() => navigation.goBack());
        } else {
          Animated.parallel([
            Animated.spring(dismissY, { toValue: 0, useNativeDriver: true }),
            Animated.spring(dismissOpacity, { toValue: 1, useNativeDriver: true }),
          ]).start();
        }
      },
    }),
  ).current;

  // ── Art scale (play/pause) ─────────────────────────────────────────
  const artScale = useRef(new Animated.Value(isPlaying ? 1 : 0.90)).current;

  useEffect(() => {
    Animated.spring(artScale, {
      toValue: isPlaying ? 1 : 0.90,
      useNativeDriver: true,
      stiffness: 200,
      damping: 20,
    }).start();
  }, [isPlaying, artScale]);

  // ── Sleep timer tick ──────────────────────────────────────────────
  useEffect(() => {
    if (!sleepTimerEndsAt) {
      setSleepRemaining(0);
      return;
    }

    setSleepRemaining(Math.max(0, sleepTimerEndsAt - Date.now()));

    const interval = setInterval(() => {
      const remaining = sleepTimerEndsAt - Date.now();
      setSleepRemaining(Math.max(0, remaining));

      if (remaining <= 0) {
        TrackPlayer.pause().catch(() => {});
        TrackPlayer.setVolume(1).catch(() => {});
        setSleepTimer(null);
        clearInterval(interval);
        return;
      }

      if (remaining <= 30000) {
        const vol = Math.max(0, remaining / 30000);
        TrackPlayer.setVolume(vol).catch(() => {});
      }
    }, 1000);

    return () => {
      clearInterval(interval);
      TrackPlayer.setVolume(1).catch(() => {});
    };
  }, [sleepTimerEndsAt, setSleepTimer]);

  // ── Draggable progress bar ─────────────────────────────────────────
  const progressBarWidth = useRef(W - Spacing.xl * 2);
  const isDraggingProgress = useRef(false);
  const draggedProgress = useRef(progress ?? 0);

  const progressPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        isDraggingProgress.current = true;
        haptics.light();
        const x = e.nativeEvent.locationX;
        draggedProgress.current = Math.max(0, Math.min(1, x / progressBarWidth.current));
        seekTo(draggedProgress.current);
      },
      onPanResponderMove: (e) => {
        const x = e.nativeEvent.locationX;
        draggedProgress.current = Math.max(0, Math.min(1, x / progressBarWidth.current));
        seekTo(draggedProgress.current);
      },
      onPanResponderRelease: () => {
        isDraggingProgress.current = false;
      },
    }),
  ).current;

  const handleSkipNext = useCallback(() => {
    haptics.medium();
    skipNext();
  }, [skipNext]);

  const handleSkipPrev = useCallback(() => {
    haptics.medium();
    skipPrevious();
  }, [skipPrevious]);

  const artColor = currentTrack?.artworkColor ?? Colors.bgTertiary;
  const elapsed = Math.floor((progress ?? 0) * (duration ?? 0));
  const remaining = Math.floor(Math.max(0, (duration ?? 0) - elapsed));
  const progressPct = Math.round((progress ?? 0) * 100);

  if (!currentTrack) {
    return (
      <View style={[styles.root, { justifyContent: 'center', alignItems: 'center' }]}>
        <LinearGradient
          colors={['rgba(139, 92, 46, 0.20)', 'transparent']}
          style={StyleSheet.absoluteFill}
        />
        <Text style={{ ...Typography.headingMd, color: Colors.textSecondary }}>
          No track selected
        </Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={{ marginTop: Spacing.xl }}>
          <Text style={{ color: Colors.accentPrimary }}>Go back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <Animated.View
      style={[styles.root, { transform: [{ translateY: dismissY }], opacity: dismissOpacity }]}
    >
      <StatusBar barStyle="light-content" />

      {/* Ambient gradient from album art */}
      <LinearGradient
        colors={[artColor + 'AA', 'rgba(13,13,20,0.85)']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />
      {/* Blur overlay for glass effect */}
      <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={['transparent', 'rgba(233, 30, 140, 0.04)']}
        style={[StyleSheet.absoluteFill, { top: '60%' }]}
      />

      <View style={{ paddingTop: insets.top, flex: 1, paddingHorizontal: Spacing.xl }}>
        {/* Header — drag handle for dismiss */}
        <View {...dismissPan.panHandlers} style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <ChevronDown size={28} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerLabel}>NOW PLAYING</Text>
            {sleepTimerEndsAt && sleepRemaining > 0 && (
              <View style={styles.sleepCountdown}>
                <Moon size={10} color={Colors.accentPurple} />
                <Text style={styles.sleepCountdownText}>
                  {formatSleepCountdown(sleepRemaining)}
                </Text>
              </View>
            )}
          </View>
          <TouchableOpacity style={styles.headerBtn} onPress={() => setShowQueue(true)}>
            <AlignJustify size={22} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>
        </View>

        {/* Album Art — larger */}
        <View style={styles.artContainer}>
          <Animated.View style={{ transform: [{ scale: artScale }] }}>
            <View style={[styles.artBlurRing, { width: ART_SIZE + 32, height: ART_SIZE + 32, borderRadius: Radius.xl + 16 }]}>
              <BlurView intensity={25} tint="dark" style={StyleSheet.absoluteFill} />
            </View>
            <AlbumArtCarousel
              artwork={currentTrack.artwork}
              artColor={artColor}
              artSize={ART_SIZE}
              onSwipeLeft={handleSkipNext}
              onSwipeRight={handleSkipPrev}
            />
          </Animated.View>
        </View>

        {/* Track Info + Heart */}
        <View style={styles.infoRow}>
          <View style={styles.infoText}>
            <Text style={styles.trackTitle} numberOfLines={1}>
              {currentTrack.title}
            </Text>
            <Text style={styles.trackArtist} numberOfLines={1}>
              {currentTrack.artist}
            </Text>
          </View>
          <HeartButton
            liked={isLiked(currentTrack.id)}
            onToggle={() => toggleLike(currentTrack.id, currentTrack)}
            size={24}
          />
        </View>

        {/* Progress / Waveform */}
        <View style={styles.progressSection}>
          {currentTrack.source === 'soundcloud' ? (
            <WaveformBar
              trackId={currentTrack.id}
              progress={progress ?? 0}
              onSeek={seekTo}
            />
          ) : (
            <View
              {...progressPan.panHandlers}
              style={styles.progressHitArea}
              onLayout={(e) => { progressBarWidth.current = e.nativeEvent.layout.width; }}
            >
              <View style={styles.progressBg}>
                <View style={[styles.progressFill, { width: `${progressPct}%` as `${number}%` }]}>
                  <View style={styles.progressThumb} />
                </View>
              </View>
            </View>
          )}
          <View style={styles.timeRow}>
            <Text style={styles.time}>{formatDuration(elapsed)}</Text>
            <Text style={styles.time}>-{formatDuration(remaining)}</Text>
          </View>
        </View>

        {/* Controls — Glass Card */}
        <GlassCard style={styles.controlsGlass} intensity={30} glassStyle="clear">
          <View style={styles.controls}>
            <TouchableOpacity onPress={toggleShuffle} style={styles.ctrlSm}>
              <Shuffle size={20} color={isShuffled ? Colors.accentPrimary : 'rgba(255,255,255,0.6)'} />
            </TouchableOpacity>

            <TouchableOpacity onPress={skipPrevious} style={styles.ctrlMd}>
              <SkipBack size={28} color={Colors.textPrimary} fill={Colors.textPrimary} />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => { haptics.light(); togglePlayPause(); }}
              style={styles.playBtn}
              activeOpacity={0.85}
            >
              <BlurView intensity={80} tint="light" style={styles.playBtnBlur}>
                {isPlaying ? (
                  <Pause size={30} color="rgba(0,0,0,0.85)" fill="rgba(0,0,0,0.85)" />
                ) : (
                  <Play size={30} color="rgba(0,0,0,0.85)" fill="rgba(0,0,0,0.85)" style={{ marginLeft: 3 }} />
                )}
              </BlurView>
            </TouchableOpacity>

            <TouchableOpacity onPress={skipNext} style={styles.ctrlMd}>
              <SkipForward size={28} color={Colors.textPrimary} fill={Colors.textPrimary} />
            </TouchableOpacity>

            <TouchableOpacity onPress={toggleRepeat} style={styles.ctrlSm}>
              {repeatMode === 'track' ? (
                <Repeat1 size={20} color={Colors.accentPrimary} />
              ) : (
                <Repeat size={20} color={repeatMode !== 'off' ? Colors.accentPrimary : 'rgba(255,255,255,0.6)'} />
              )}
            </TouchableOpacity>
          </View>
        </GlassCard>

        {/* Bottom Row */}
        <View style={[styles.bottomRow, { paddingBottom: insets.bottom + Spacing.sm }]}>
          <TouchableOpacity style={styles.bottomBtn} onPress={() => setShowLyrics(true)}>
            <Mic2 size={20} color="rgba(255,255,255,0.6)" />
            <Text style={styles.bottomLabel}>Lyrics</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Lyrics Modal */}
      <Modal
        visible={showLyrics}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowLyrics(false)}
      >
        <SafeAreaView style={styles.lyricsModal}>
          <View style={styles.lyricsHeader}>
            <View style={{ width: 60 }} />
            <View style={{ alignItems: 'center' }}>
              <Text style={styles.lyricsTitle} numberOfLines={1}>
                {currentTrack.title}
              </Text>
              <Text style={styles.lyricsArtist} numberOfLines={1}>
                {currentTrack.artist}
              </Text>
            </View>
            <TouchableOpacity
              style={{ width: 60, alignItems: 'flex-end', paddingRight: Spacing.lg }}
              onPress={() => setShowLyrics(false)}
            >
              <Text style={{ color: Colors.accentPrimary, fontSize: 15 }}>Done</Text>
            </TouchableOpacity>
          </View>
          <LyricsView
            trackId={currentTrack.id}
            artist={currentTrack.artist}
            title={currentTrack.title}
            duration={duration ?? 0}
            progress={progress ?? 0}
            onSeek={seekTo}
          />
        </SafeAreaView>
      </Modal>

      {/* Queue */}
      <QueueSheet visible={showQueue} onClose={() => setShowQueue(false)} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Spacing.sm,
    marginBottom: Spacing.md,
  },
  headerBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headerLabel: {
    ...Typography.caption,
    color: 'rgba(255,255,255,0.5)',
    letterSpacing: 1.5,
  },
  sleepCountdown: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 2,
  },
  sleepCountdownText: {
    ...Typography.caption,
    color: Colors.accentPurple,
    fontSize: 10,
  },
  artContainer: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  artBlurRing: {
    position: 'absolute',
    alignSelf: 'center',
    top: -16,
    left: -16,
    overflow: 'hidden',
    opacity: 0.5,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  infoText: {
    flex: 1,
    gap: 5,
  },
  trackTitle: {
    ...Typography.headingLg,
    color: Colors.textPrimary,
  },
  trackArtist: {
    ...Typography.body,
    color: 'rgba(255,255,255,0.65)',
  },
  progressSection: {
    marginBottom: Spacing.lg,
  },
  progressHitArea: {
    paddingVertical: Spacing.sm,
  },
  progressBg: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 2,
  },
  progressFill: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: 2,
    position: 'relative',
  },
  progressThumb: {
    position: 'absolute',
    right: -7,
    top: -5,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#fff',
    shadowColor: '#fff',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.xs,
  },
  time: {
    ...Typography.caption,
    color: 'rgba(255,255,255,0.4)',
  },
  controlsGlass: {
    marginHorizontal: -Spacing.sm,
    marginBottom: Spacing.md,
    padding: Spacing.sm,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.sm,
  },
  ctrlSm: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctrlMd: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 66,
    height: 66,
    borderRadius: 33,
    overflow: 'hidden',
    shadowColor: 'rgba(255,255,255,0.3)',
    shadowOpacity: 1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  playBtnBlur: {
    width: 66,
    height: 66,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  bottomBtn: {
    alignItems: 'center',
    gap: Spacing.xs,
  },
  bottomLabel: {
    ...Typography.caption,
    color: 'rgba(255,255,255,0.4)',
  },
  lyricsModal: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
  },
  lyricsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.glassBorder,
  },
  lyricsTitle: {
    ...Typography.bodySm,
    color: Colors.textPrimary,
    fontWeight: '600',
  },
  lyricsArtist: {
    ...Typography.caption,
    color: Colors.textSecondary,
  },
});
