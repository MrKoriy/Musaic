import React, { useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Image,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Play, Pause, SkipForward } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlayerStore } from '../stores/usePlayerStore';
import { Colors, Spacing, Typography, Radius, Shadows } from '../theme';
import { RootStackParamList } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

export function MiniPlayer() {
  const navigation = useNavigation<NavProp>();
  const insets = useSafeAreaInsets();
  const { currentTrack, isPlaying, progress, setIsPlaying, skipNext } = usePlayerStore();
  const scale = useRef(new Animated.Value(1)).current;

  if (!currentTrack) return null;

  function handlePressIn() {
    Animated.spring(scale, { toValue: 0.98, useNativeDriver: true }).start();
  }

  function handlePressOut() {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
  }

  function handlePress() {
    navigation.navigate('NowPlaying');
  }

  return (
    <Animated.View
      style={[styles.wrapper, { transform: [{ scale }] }]}
    >
      <TouchableOpacity
        activeOpacity={1}
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={styles.touchable}
      >
        <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
        {/* Glass border */}
        <View style={styles.border} pointerEvents="none" />

        {/* Progress bar at top */}
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.round((progress ?? 0) * 100)}%` as any },
            ]}
          />
        </View>

        <View style={styles.inner}>
          {/* Artwork */}
          {currentTrack.artwork ? (
            <Image source={{ uri: currentTrack.artwork }} style={styles.artwork} />
          ) : (
            <View style={[styles.artwork, { backgroundColor: (currentTrack as any).artworkColor ?? Colors.bgTertiary }]}>
              <Text style={styles.artworkNote}>♪</Text>
            </View>
          )}

          {/* Track info */}
          <View style={styles.info}>
            <Text style={styles.title} numberOfLines={1}>
              {currentTrack.title}
            </Text>
            <Text style={styles.artist} numberOfLines={1}>
              {currentTrack.artist}
            </Text>
          </View>

          {/* Controls */}
          <TouchableOpacity
            style={styles.ctrl}
            onPress={(e) => {
              e.stopPropagation?.();
              setIsPlaying(!isPlaying);
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            {isPlaying ? (
              <Pause size={22} color={Colors.textPrimary} fill={Colors.textPrimary} />
            ) : (
              <Play size={22} color={Colors.textPrimary} fill={Colors.textPrimary} />
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.ctrl}
            onPress={(e) => {
              e.stopPropagation?.();
              skipNext();
            }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <SkipForward size={22} color={Colors.textPrimary} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.xs,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: 'rgba(28, 28, 40, 0.7)',
    ...Shadows.glass,
  },
  touchable: {
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  border: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    borderRadius: Radius.lg,
    zIndex: 1,
  },
  progressTrack: {
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  progressFill: {
    height: 2,
    backgroundColor: Colors.accentPrimary,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    gap: Spacing.md,
    height: 62,
  },
  artwork: {
    width: 42,
    height: 42,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  artworkNote: {
    fontSize: 18,
    color: 'rgba(255,255,255,0.5)',
  },
  info: {
    flex: 1,
    gap: 3,
  },
  title: {
    ...(Typography.headingSm as object),
    color: Colors.textPrimary,
  },
  artist: {
    ...(Typography.bodySm as object),
    color: Colors.textSecondary,
  },
  ctrl: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
