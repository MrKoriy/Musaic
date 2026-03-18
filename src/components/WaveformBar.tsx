import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors } from '../theme';
import { getSCWaveform } from '../services/apiService';

type Props = {
  trackId: string;
  progress: number; // 0–1
  onSeek?: (progress: number) => void;
};

const BAR_COUNT = 60;
const BAR_MIN_HEIGHT = 3;
const BAR_MAX_HEIGHT = 36;

export function WaveformBar({ trackId, progress, onSeek }: Props) {
  const [samples, setSamples] = useState<number[]>([]);
  const containerRef = useRef<View>(null);
  const containerWidth = useRef(0);

  useEffect(() => {
    if (!trackId.startsWith('sc_')) return;
    getSCWaveform(trackId)
      .then(({ samples: raw }) => {
        if (!raw.length) return;
        // Downsample to BAR_COUNT bars
        const step = raw.length / BAR_COUNT;
        const bars: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          const start = Math.floor(i * step);
          const end = Math.min(Math.floor((i + 1) * step), raw.length);
          let sum = 0;
          for (let j = start; j < end; j++) sum += raw[j]!;
          bars.push(sum / (end - start));
        }
        const max = Math.max(...bars, 1);
        setSamples(bars.map((b) => b / max));
      })
      .catch(() => {});
  }, [trackId]);

  if (!samples.length) return null;

  const playedCount = Math.round(progress * BAR_COUNT);

  return (
    <TouchableOpacity
      activeOpacity={1}
      style={styles.container}
      onLayout={(e) => { containerWidth.current = e.nativeEvent.layout.width; }}
      onPress={(e) => {
        if (containerWidth.current > 0 && onSeek) {
          const x = e.nativeEvent.locationX;
          onSeek(Math.max(0, Math.min(1, x / containerWidth.current)));
        }
      }}
    >
      {samples.map((amplitude, i) => {
        const height = BAR_MIN_HEIGHT + amplitude * (BAR_MAX_HEIGHT - BAR_MIN_HEIGHT);
        const played = i < playedCount;
        return (
          <View
            key={i}
            style={[
              styles.bar,
              { height },
              played ? styles.barPlayed : styles.barUnplayed,
            ]}
          />
        );
      })}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    height: BAR_MAX_HEIGHT + 8,
    gap: 2,
  },
  bar: {
    flex: 1,
    borderRadius: 2,
  },
  barPlayed: {
    backgroundColor: Colors.accentPrimary,
  },
  barUnplayed: {
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
});
