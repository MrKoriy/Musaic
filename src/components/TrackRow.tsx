import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ViewStyle, Image, Alert,
} from 'react-native';
import { Track } from '../types';
import { PlayingIndicator } from './PlayingIndicator';
import { HeartButton } from './HeartButton';
import { DownloadButton } from './DownloadButton';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { formatDuration } from '../data/mockData';

type Props = {
  track: Track & { artworkColor?: string };
  index: number;
  isPlaying?: boolean;
  isCurrent?: boolean;
  isLiked?: boolean;
  showDownload?: boolean;
  onPress?: () => void;
  onLike?: (liked: boolean) => void;
  onMoreLikeThis?: (track: Track) => void;
  onAddToQueue?: (track: Track) => void;
  style?: ViewStyle;
};

export function TrackRow({
  track, index, isPlaying, isCurrent, isLiked, showDownload, onPress, onLike, onMoreLikeThis, onAddToQueue, style,
}: Props) {
  function handleLongPress() {
    if (!onMoreLikeThis && !onAddToQueue) return;
    const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }> = [];
    if (onMoreLikeThis) buttons.push({ text: 'More Like This', onPress: () => onMoreLikeThis(track) });
    if (onAddToQueue) buttons.push({ text: 'Add to Queue', onPress: () => onAddToQueue(track) });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert(track.title, track.artist, buttons);
  }

  return (
    <TouchableOpacity
      style={[styles.row, isCurrent && styles.rowActive, style]}
      onPress={onPress}
      onLongPress={(onMoreLikeThis || onAddToQueue) ? handleLongPress : undefined}
      activeOpacity={0.7}
      delayLongPress={400}
    >
      {/* Left: index or playing indicator */}
      <View style={styles.indexBox}>
        {isCurrent ? (
          <PlayingIndicator playing={isPlaying} size="sm" />
        ) : (
          <Text style={styles.indexText}>{index}</Text>
        )}
      </View>

      {/* Artwork */}
      {track.artwork ? (
        <Image source={{ uri: track.artwork }} style={styles.artwork} />
      ) : (
        <View style={[styles.artwork, { backgroundColor: track.artworkColor ?? Colors.bgTertiary }]}>
          <Text style={styles.artworkNote}>♪</Text>
        </View>
      )}

      {/* Info */}
      <View style={styles.info}>
        <Text
          style={[styles.title, isCurrent && styles.titleCurrent]}
          numberOfLines={1}
        >
          {track.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {track.artist}
        </Text>
      </View>

      {/* Duration */}
      {track.duration !== undefined && (
        <Text style={styles.duration}>{formatDuration(track.duration)}</Text>
      )}

      {/* Download button (opt-in) */}
      {showDownload && <DownloadButton track={track} size={16} />}

      {/* Heart */}
      <HeartButton liked={isLiked} onToggle={onLike} size={16} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.sm,
    gap: Spacing.md,
  },
  rowActive: {
    backgroundColor: Colors.glassBgHover,
  },
  indexBox: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 14,
  },
  indexText: {
    ...(Typography.bodySm as object),
    color: Colors.textTertiary,
  },
  artwork: {
    width: 40,
    height: 40,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  artworkNote: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.5)',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...(Typography.body as object),
    color: Colors.textPrimary,
    fontWeight: '500',
  },
  titleCurrent: {
    color: Colors.accentPrimary,
  },
  artist: {
    ...(Typography.bodySm as object),
    color: Colors.textSecondary,
  },
  duration: {
    ...(Typography.bodySm as object),
    color: Colors.textTertiary,
    width: 38,
    textAlign: 'right',
  },
});
