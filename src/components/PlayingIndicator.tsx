import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { Colors } from '../theme';

type Props = {
  playing?: boolean;
  size?: 'sm' | 'md';
  color?: string;
};

const BAR_CONFIGS = [
  { delay: 0, duration: 800 },
  { delay: 150, duration: 600 },
  { delay: 300, duration: 700 },
];

function AnimatedBar({
  delay,
  duration,
  maxH,
  minH,
  width,
}: {
  delay: number;
  duration: number;
  maxH: number;
  minH: number;
  width: number;
}) {
  const anim = useRef(new Animated.Value(minH)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: maxH,
          duration: duration / 2,
          delay,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(anim, {
          toValue: minH,
          duration: duration / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <Animated.View
      style={{
        width,
        height: anim,
        backgroundColor: Colors.accentPrimary,
        borderRadius: 2,
      }}
    />
  );
}

export function PlayingIndicator({ playing = true, size = 'md', color }: Props) {
  const maxH = size === 'sm' ? 10 : 14;
  const minH = size === 'sm' ? 3 : 4;
  const barWidth = size === 'sm' ? 2 : 3;

  return (
    <View style={[styles.container]}>
      {BAR_CONFIGS.map((cfg, i) =>
        playing ? (
          <AnimatedBar
            key={i}
            delay={cfg.delay}
            duration={cfg.duration}
            maxH={maxH}
            minH={minH}
            width={barWidth}
          />
        ) : (
          <View
            key={i}
            style={{
              width: barWidth,
              height: maxH / 2,
              backgroundColor: color ?? Colors.accentPrimary,
              borderRadius: 2,
            }}
          />
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
  },
});
