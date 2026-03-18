import React from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { Colors, Radius, Shadows } from '../theme';

interface GlassCardProps {
  children: React.ReactNode;
  style?: ViewStyle;
  intensity?: number; // blur intensity 0-100
  borderRadius?: number;
}

export function GlassCard({
  children,
  style,
  intensity = 40,
  borderRadius = Radius.md,
}: GlassCardProps) {
  return (
    <View style={[styles.container, { borderRadius }, Shadows.glass, style]}>
      <BlurView
        intensity={intensity}
        tint="dark"
        style={[styles.blur, { borderRadius }]}
      >
        <View style={[styles.inner, { borderRadius }]}>{children}</View>
      </BlurView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  blur: {
    overflow: 'hidden',
  },
  inner: {
    backgroundColor: Colors.glassBg,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    // Inner glow
    shadowColor: 'rgba(255,255,255,0.05)',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 0,
  },
});
