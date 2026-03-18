import React, { useEffect } from 'react';
import { View, Image, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  cancelAnimation,
  Easing,
} from 'react-native-reanimated';

interface VinylAnimationProps {
  artwork?: string;
  artColor?: string;
  isPlaying: boolean;
  size?: number;
}

export function VinylAnimation({ artwork, artColor, isPlaying, size = 280 }: VinylAnimationProps) {
  const rotation = useSharedValue(0);

  useEffect(() => {
    if (isPlaying) {
      rotation.value = withRepeat(
        withTiming(360, { duration: 4000, easing: Easing.linear }),
        -1,
        false,
      );
    } else {
      cancelAnimation(rotation);
    }
  }, [isPlaying, rotation]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const artSize = size * 0.38;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[styles.record, { width: size, height: size, borderRadius: size / 2 }, animStyle]}>
        {/* Grooves */}
        {[0.85, 0.75, 0.65, 0.55].map((ratio) => (
          <View
            key={ratio}
            style={[styles.groove, {
              width: size * ratio,
              height: size * ratio,
              borderRadius: (size * ratio) / 2,
            }]}
          />
        ))}

        {/* Center label */}
        <View style={[styles.label, {
          width: artSize,
          height: artSize,
          borderRadius: artSize / 2,
          backgroundColor: artColor ?? '#3a3a4a',
        }]}>
          {artwork ? (
            <Image
              source={{ uri: artwork }}
              style={{ width: artSize, height: artSize, borderRadius: artSize / 2 }}
            />
          ) : null}
        </View>

        {/* Spindle */}
        <View style={styles.spindle} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  record: {
    backgroundColor: '#141414',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.6,
    shadowRadius: 30,
    elevation: 20,
  },
  groove: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.04)',
  },
  label: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  spindle: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
});
