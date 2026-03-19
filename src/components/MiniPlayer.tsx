import React, { useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated,
  Image, PanResponder, PanResponderGestureState, LayoutChangeEvent,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Play, Pause, SkipForward } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { usePlayerStore } from '../stores/usePlayerStore';
import { Colors, Spacing, Typography, Radius, Shadows } from '../theme';
import { RootStackParamList } from '../types';
import { haptics } from '../utils/haptics';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

const SWIPE_UP_THRESHOLD = -40;
const SWIPE_HORIZ_THRESHOLD = 60;
const MARQUEE_SPEED = 40; // pts per second
const MARQUEE_PAUSE = 1500; // ms pause at each end

// ── Marquee Text ──────────────────────────────────────────────────────────────

function MarqueeText({ text, style, containerWidth }: {
  text: string;
  style?: object;
  containerWidth: number;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const textWidthRef = useRef(0);
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  const startAnimation = useCallback(() => {
    if (animRef.current) {
      animRef.current.stop();
      animRef.current = null;
    }
    const overflow = textWidthRef.current - containerWidth;
    if (overflow <= 0) {
      translateX.setValue(0);
      return;
    }
    const duration = (overflow / MARQUEE_SPEED) * 1000;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(MARQUEE_PAUSE),
        Animated.timing(translateX, { toValue: -overflow, duration, useNativeDriver: true }),
        Animated.delay(MARQUEE_PAUSE),
        Animated.timing(translateX, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]),
    );
    animRef.current = anim;
    anim.start();
  }, [containerWidth, translateX]);

  useEffect(() => {
    translateX.setValue(0);
    startAnimation();
    return () => { animRef.current?.stop(); };
  }, [text, containerWidth, startAnimation, translateX]);

  function onTextLayout(e: any) {
    const w = e.nativeEvent.layout.width;
    if (w !== textWidthRef.current) {
      textWidthRef.current = w;
      startAnimation();
    }
  }

  if (!containerWidth) {
    return <Text style={style} numberOfLines={1}>{text}</Text>;
  }

  return (
    <View style={{ width: containerWidth, overflow: 'hidden' }}>
      <Animated.Text
        style={[style, { transform: [{ translateX }] }]}
        numberOfLines={1}
        onLayout={onTextLayout}
      >
        {text}
      </Animated.Text>
    </View>
  );
}

// ── MiniPlayer ────────────────────────────────────────────────────────────────

export function MiniPlayer() {
  const navigation = useNavigation<NavProp>();
  const { currentTrack, isPlaying, progress, setIsPlaying, skipNext, skipPrevious } = usePlayerStore();
  const scale = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const infoPanelWidth = useRef(0);
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_evt, gestureState: PanResponderGestureState) => {
        const { dx, dy } = gestureState;
        return Math.abs(dx) > 8 || Math.abs(dy) > 8;
      },
      onPanResponderGrant: () => {
        Animated.spring(scale, { toValue: 0.97, useNativeDriver: true }).start();
      },
      onPanResponderMove: (_evt, gestureState) => {
        const { dy } = gestureState;
        if (dy < 0) {
          translateY.setValue(Math.max(dy, -60));
        }
      },
      onPanResponderRelease: (_evt, gestureState: PanResponderGestureState) => {
        const { dx, dy, vx, vy } = gestureState;
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();

        const isUpSwipe = (dy < SWIPE_UP_THRESHOLD || vy < -0.5) && Math.abs(dy) > Math.abs(dx);
        const isRightSwipe = (dx > SWIPE_HORIZ_THRESHOLD || vx > 0.5) && Math.abs(dx) > Math.abs(dy);
        const isLeftSwipe = (dx < -SWIPE_HORIZ_THRESHOLD || vx < -0.5) && Math.abs(dx) > Math.abs(dy);

        if (isUpSwipe) {
          Animated.timing(translateY, { toValue: -80, duration: 180, useNativeDriver: true }).start(() => {
            translateY.setValue(0);
            navigation.navigate('NowPlaying');
          });
        } else if (isRightSwipe) {
          haptics.medium();
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
          skipPrevious();
        } else if (isLeftSwipe) {
          haptics.medium();
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
          skipNext();
        } else {
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  if (!currentTrack) return null;

  function handleInfoLayout(e: LayoutChangeEvent) {
    infoPanelWidth.current = e.nativeEvent.layout.width;
  }

  function openNowPlaying() {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
    translateY.setValue(0);
    navigation.navigate('NowPlaying');
  }

  function handlePressIn() {
    Animated.spring(scale, { toValue: 0.97, useNativeDriver: true }).start();
  }

  function handlePressOut() {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
  }

  return (
    <Animated.View
      style={[styles.wrapper, { transform: [{ scale }, { translateY }] }]}
      {...panResponder.panHandlers}
    >
      <TouchableOpacity
        activeOpacity={1}
        onPress={openNowPlaying}
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
              { width: `${Math.round((progress ?? 0) * 100)}%` },
            ]}
          />
        </View>

        <View style={styles.inner}>
          {/* Artwork */}
          {currentTrack.artwork ? (
            <Image source={{ uri: currentTrack.artwork }} style={styles.artwork} />
          ) : (
            <View style={[styles.artwork, { backgroundColor: currentTrack.artworkColor ?? Colors.bgTertiary }]}>
              <Text style={styles.artworkNote}>♪</Text>
            </View>
          )}

          {/* Track info with marquee scrolling */}
          <View style={styles.info} onLayout={handleInfoLayout}>
            <MarqueeText
              text={currentTrack.title}
              style={styles.title}
              containerWidth={infoPanelWidth.current}
            />
            <MarqueeText
              text={currentTrack.artist ?? ''}
              style={styles.artist}
              containerWidth={infoPanelWidth.current}
            />
          </View>

          {/* Controls */}
          <TouchableOpacity
            style={styles.ctrl}
            onPress={(e) => {
              e.stopPropagation?.();
              haptics.light();
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
              haptics.medium();
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
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  progressFill: {
    height: 3,
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
    overflow: 'hidden',
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
