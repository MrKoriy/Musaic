import React, { useRef, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  Dimensions, PanResponder, Image, Modal, SafeAreaView,
} from 'react-native';
import {
  ChevronDown, Play, Pause, SkipBack, SkipForward,
  Shuffle, Repeat, AlignJustify, Mic2, Sparkles,
} from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Spacing, Typography, Radius, Shadows } from '../theme';
import { HeartButton } from '../components/HeartButton';
import { WaveformBar } from '../components/WaveformBar';
import { LyricsView } from '../components/LyricsView';
import { QueueSheet } from '../components/QueueSheet';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import { MoreLikeThisModal } from '../components/MoreLikeThisModal';
import { formatDuration } from '../data/mockData';

const { width: W } = Dimensions.get('window');
const ART_SIZE = W - Spacing.xl * 4;

export function NowPlayingScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [showLyrics, setShowLyrics] = useState(false);
  const [showMoreLikeThis, setShowMoreLikeThis] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const {
    currentTrack, isPlaying, progress, duration,
    setIsPlaying, skipNext, skipPrevious, seekTo,
    repeatMode, isShuffled, toggleRepeat, toggleShuffle,
  } = usePlayerStore();
  const { isLiked, toggleLike } = useLibraryStore();

  const artScale = useRef(new Animated.Value(isPlaying ? 1 : 0.92)).current;

  useEffect(() => {
    Animated.spring(artScale, {
      toValue: isPlaying ? 1 : 0.92,
      useNativeDriver: true,
      stiffness: 200,
      damping: 20,
    }).start();
  }, [isPlaying]);

  const artColor = currentTrack?.artworkColor ?? Colors.bgTertiary;
  const elapsed = Math.floor((progress ?? 0) * (duration ?? 0));
  const remaining = Math.max(0, (duration ?? 0) - elapsed);
  const progressWidth = `${Math.round((progress ?? 0) * 100)}%` as `${number}%`;

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
    <View style={styles.root}>
      {/* Ambient color from album art */}
      <LinearGradient
        colors={[artColor + 'CC', Colors.bgPrimary]}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.55 }}
      />
      {/* Cool accent at bottom */}
      <LinearGradient
        colors={['transparent', 'rgba(233, 30, 140, 0.06)']}
        style={[StyleSheet.absoluteFill, { top: '55%' }]}
      />

      <View style={{ paddingTop: insets.top, flex: 1, paddingHorizontal: Spacing.xl }}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <ChevronDown size={28} color={Colors.textSecondary} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.headerLabel}>NOW PLAYING</Text>
          </View>
          <View style={styles.headerBtn} />
        </View>

        {/* Album Art */}
        <View style={styles.artContainer}>
          <Animated.View
            style={[
              styles.artShadow,
              { shadowColor: artColor, transform: [{ scale: artScale }] },
            ]}
          >
            {currentTrack.artwork ? (
              <Image
                source={{ uri: currentTrack.artwork }}
                style={[styles.art, { width: ART_SIZE, height: ART_SIZE }]}
              />
            ) : (
              <View style={[styles.art, { backgroundColor: artColor, width: ART_SIZE, height: ART_SIZE }]}>
                <Text style={styles.artNote}>♪</Text>
              </View>
            )}
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
            onToggle={() => toggleLike(currentTrack.id)}
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
            <TouchableOpacity
              style={styles.progressHitArea}
              onPress={(e) => {
                const x = e.nativeEvent.locationX;
                const trackW = W - Spacing.xl * 2;
                const newProgress = Math.max(0, Math.min(1, x / trackW));
                seekTo(newProgress);
              }}
              activeOpacity={1}
            >
              <View style={styles.progressBg}>
                <View style={[styles.progressFill, { width: progressWidth }]}>
                  <View style={styles.progressThumb} />
                </View>
              </View>
            </TouchableOpacity>
          )}
          <View style={styles.timeRow}>
            <Text style={styles.time}>{formatDuration(elapsed)}</Text>
            <Text style={styles.time}>-{formatDuration(remaining)}</Text>
          </View>
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          <TouchableOpacity
            onPress={toggleShuffle}
            style={styles.ctrlSm}
          >
            <Shuffle
              size={20}
              color={isShuffled ? Colors.accentPrimary : Colors.textSecondary}
            />
          </TouchableOpacity>

          <TouchableOpacity onPress={skipPrevious} style={styles.ctrlMd}>
            <SkipBack size={28} color={Colors.textPrimary} fill={Colors.textPrimary} />
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => setIsPlaying(!isPlaying)}
            style={styles.playBtn}
            activeOpacity={0.85}
          >
            {isPlaying ? (
              <Pause size={30} color={Colors.bgPrimary} fill={Colors.bgPrimary} />
            ) : (
              <Play size={30} color={Colors.bgPrimary} fill={Colors.bgPrimary} style={{ marginLeft: 3 }} />
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={skipNext} style={styles.ctrlMd}>
            <SkipForward size={28} color={Colors.textPrimary} fill={Colors.textPrimary} />
          </TouchableOpacity>

          <TouchableOpacity onPress={toggleRepeat} style={styles.ctrlSm}>
            <Repeat
              size={20}
              color={repeatMode !== 'off' ? Colors.accentPrimary : Colors.textSecondary}
            />
          </TouchableOpacity>
        </View>

        {/* Bottom Row */}
        <View style={[styles.bottomRow, { paddingBottom: insets.bottom + Spacing.sm }]}>
          <TouchableOpacity style={styles.bottomBtn} onPress={() => setShowQueue(true)}>
            <AlignJustify size={20} color={Colors.textSecondary} />
            <Text style={styles.bottomLabel}>Queue</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.bottomBtn} onPress={() => setShowLyrics(true)}>
            <Mic2 size={20} color={Colors.textSecondary} />
            <Text style={styles.bottomLabel}>Lyrics</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.bottomBtn} onPress={() => setShowMoreLikeThis(true)}>
            <Sparkles size={20} color={Colors.textSecondary} />
            <Text style={styles.bottomLabel}>Similar</Text>
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
          {/* Modal header */}
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

      {/* More Like This */}
      <MoreLikeThisModal
        track={showMoreLikeThis ? currentTrack : null}
        onClose={() => setShowMoreLikeThis(false)}
        onPlay={(similarTracks, index) => {
          setShowMoreLikeThis(false);
          usePlayerStore.getState().setQueue(similarTracks, index);
        }}
      />

      {/* Queue */}
      <QueueSheet visible={showQueue} onClose={() => setShowQueue(false)} />
    </View>
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
    paddingTop: Spacing.md,
    marginBottom: Spacing.xl,
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
    color: Colors.textSecondary,
    letterSpacing: 1.5,
  },
  artContainer: {
    alignItems: 'center',
    marginBottom: Spacing.xl,
  },
  artShadow: {
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.5,
    shadowRadius: 40,
    elevation: 20,
  },
  art: {
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artNote: {
    fontSize: 72,
    color: 'rgba(255,255,255,0.25)',
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.xl,
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
    color: Colors.textSecondary,
  },
  progressSection: {
    marginBottom: Spacing.xl,
  },
  progressHitArea: {
    paddingVertical: Spacing.sm,
  },
  progressBg: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 2,
  },
  progressFill: {
    height: 3,
    backgroundColor: Colors.accentPrimary,
    borderRadius: 2,
    position: 'relative',
  },
  progressThumb: {
    position: 'absolute',
    right: -6,
    top: -4.5,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#fff',
    shadowColor: '#fff',
    shadowOpacity: 0.4,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: Spacing.xs,
  },
  time: {
    ...Typography.caption,
    color: Colors.textTertiary,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.xl,
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
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#fff',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
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
    color: Colors.textTertiary,
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
