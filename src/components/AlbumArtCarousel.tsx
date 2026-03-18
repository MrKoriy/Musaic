import React, { useRef, useEffect } from 'react';
import { View, Image, StyleSheet, Animated, PanResponder, Dimensions } from 'react-native';

const { width: W } = Dimensions.get('window');
const SWIPE_THRESHOLD = W * 0.3;
const SWIPE_VELOCITY_THRESHOLD = 0.4;

interface AlbumArtCarouselProps {
  artwork?: string;
  artColor?: string;
  artSize: number;
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
}

export function AlbumArtCarousel({
  artwork,
  artColor,
  artSize,
  onSwipeLeft,
  onSwipeRight,
}: AlbumArtCarouselProps) {
  const translateX = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const artworkKey = artwork ?? 'none';

  // Crossfade when artwork changes
  useEffect(() => {
    opacity.setValue(0);
    translateX.setValue(0);
    Animated.timing(opacity, {
      toValue: 1,
      duration: 350,
      useNativeDriver: true,
    }).start();
  }, [artworkKey]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 10 && Math.abs(gs.dx) > Math.abs(gs.dy),
      onPanResponderMove: (_, gs) => {
        translateX.setValue(gs.dx * 0.4);
        opacity.setValue(Math.max(0.5, 1 - Math.abs(gs.dx) / (W * 0.8)));
      },
      onPanResponderRelease: (_, gs) => {
        const isSwipeLeft = gs.dx < -SWIPE_THRESHOLD || gs.vx < -SWIPE_VELOCITY_THRESHOLD;
        const isSwipeRight = gs.dx > SWIPE_THRESHOLD || gs.vx > SWIPE_VELOCITY_THRESHOLD;

        if (isSwipeLeft || isSwipeRight) {
          const toValue = isSwipeLeft ? -W : W;
          Animated.parallel([
            Animated.timing(translateX, { toValue, duration: 200, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
          ]).start(() => {
            translateX.setValue(0);
            opacity.setValue(1);
            if (isSwipeLeft) onSwipeLeft();
            else onSwipeRight();
          });
        } else {
          Animated.parallel([
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
            Animated.spring(opacity, { toValue: 1, useNativeDriver: true }),
          ]).start();
        }
      },
    }),
  ).current;

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[
        styles.container,
        {
          width: artSize,
          height: artSize,
          opacity,
          transform: [{ translateX }],
        },
      ]}
    >
      {artwork ? (
        <Image source={{ uri: artwork }} style={[styles.art, { width: artSize, height: artSize }]} />
      ) : (
        <View style={[styles.placeholder, { width: artSize, height: artSize, backgroundColor: artColor ?? '#252540' }]}>
          {/* music note placeholder */}
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.5,
    shadowRadius: 40,
    elevation: 20,
  },
  art: {
    borderRadius: 20,
  },
  placeholder: {
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
