import React, { useState, useRef } from 'react';
import { TouchableOpacity, Animated } from 'react-native';
import { Heart } from 'lucide-react-native';
import { Colors, Spacing } from '../theme';

type Props = {
  liked?: boolean;
  onToggle?: (liked: boolean) => void;
  size?: number;
};

export function HeartButton({ liked: initialLiked = false, onToggle, size = 20 }: Props) {
  const [liked, setLiked] = useState(initialLiked);
  const scale = useRef(new Animated.Value(1)).current;

  function handlePress() {
    const newLiked = !liked;
    setLiked(newLiked);
    onToggle?.(newLiked);

    if (newLiked) {
      Animated.sequence([
        Animated.timing(scale, { toValue: 0, duration: 80, useNativeDriver: true }),
        Animated.spring(scale, {
          toValue: 1.3,
          useNativeDriver: true,
          stiffness: 400,
          damping: 10,
        }),
        Animated.spring(scale, {
          toValue: 1,
          useNativeDriver: true,
          stiffness: 300,
          damping: 20,
        }),
      ]).start();
    } else {
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }).start();
    }
  }

  return (
    <TouchableOpacity
      onPress={handlePress}
      style={{ padding: Spacing.xs }}
      activeOpacity={0.8}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Heart
          size={size}
          color={liked ? Colors.accentPrimary : Colors.textTertiary}
          fill={liked ? Colors.accentPrimary : 'transparent'}
        />
      </Animated.View>
    </TouchableOpacity>
  );
}
