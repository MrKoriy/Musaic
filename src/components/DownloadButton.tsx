import React, { useCallback } from 'react';
import {
  TouchableOpacity, View, StyleSheet, Alert,
} from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withSpring, interpolate,
} from 'react-native-reanimated';
import { Download, CheckCircle2, Trash2 } from 'lucide-react-native';
import { Colors } from '../theme';
import { useDownloadStore } from '../stores/useDownloadStore';
import { Track } from '../types';

type Props = {
  track: Track;
  size?: number;
};

export function DownloadButton({ track, size = 18 }: Props) {
  const { activeDownloads, startDownload, removeDownload, isDownloaded } = useDownloadStore();

  const progress = activeDownloads[track.id]; // undefined if idle
  const downloaded = isDownloaded(track.id);
  const isActive = progress !== undefined;

  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = useCallback(async () => {
    if (isActive) return; // downloading — no-op

    if (downloaded) {
      Alert.alert(
        'Remove Download',
        `Remove "${track.title}" from downloads?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove', style: 'destructive',
            onPress: () => removeDownload(track.id),
          },
        ]
      );
      return;
    }

    scale.value = withSpring(0.85, {}, () => { scale.value = withSpring(1); });
    try {
      await startDownload(track);
    } catch {
      Alert.alert('Download failed', 'Could not download this track. Check your connection.');
    }
  }, [isActive, downloaded, track, startDownload, removeDownload, scale]);

  return (
    <TouchableOpacity onPress={handlePress} hitSlop={8} activeOpacity={0.7}>
      <Animated.View style={[styles.container, animStyle]}>
        {isActive ? (
          // Progress ring
          <View style={[styles.ring, { width: size + 6, height: size + 6 }]}>
            <ProgressRing progress={progress ?? 0} size={size + 6} />
          </View>
        ) : downloaded ? (
          <CheckCircle2 size={size} color={Colors.accentGreen} />
        ) : (
          <Download size={size} color={Colors.textTertiary} />
        )}
      </Animated.View>
    </TouchableOpacity>
  );
}

/** Simple circular progress ring drawn with border trick */
function ProgressRing({ progress, size }: { progress: number; size: number }) {
  const angle = Math.round(progress * 360);
  // Use a simple arc approach with overflow hidden
  const half = size / 2;
  return (
    <View style={{ width: size, height: size, position: 'relative' }}>
      {/* Background circle */}
      <View style={[
        StyleSheet.absoluteFill,
        { borderRadius: half, borderWidth: 2, borderColor: Colors.glassBorder },
      ]} />
      {/* Progress arc via rotate — simplified using opacity for now */}
      <View style={[
        StyleSheet.absoluteFill,
        {
          borderRadius: half,
          borderWidth: 2,
          borderColor: Colors.accentPrimary,
          borderTopColor: progress > 0.25 ? Colors.accentPrimary : 'transparent',
          borderRightColor: progress > 0.5 ? Colors.accentPrimary : 'transparent',
          borderBottomColor: progress > 0.75 ? Colors.accentPrimary : 'transparent',
          borderLeftColor: Colors.accentPrimary,
          transform: [{ rotate: `${angle - 90}deg` }],
        },
      ]} />
      {/* Download arrow inside */}
      <View style={{ ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' }}>
        <Download size={size * 0.45} color={Colors.accentPrimary} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
