import React, { useState, useEffect, useRef } from 'react';
import { TouchableOpacity, Animated } from 'react-native';
import { Heart } from 'lucide-react-native';
import { Colors, Spacing } from '../theme';
import { haptics } from '../utils/haptics';

type Props = {
  liked?: boolean;
  onToggle?: (liked: boolean) => void;
  size?: number;
};

export function HeartButton({ liked: externalLiked = false, onToggle, size = 20 }: Props) {
  const [liked, setLiked] = useState(externalLiked);
  const scale = useRef(new Animated.Value(1)).current;
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  useEffect(() => { setLiked(externalLiked); }, [externalLiked]);

  // Cancel any running animation on unmount
  useEffect(() => {
    return () => { animRef.current?.stop(); };
  }, []);

  function handlePress() {
    const newLiked = !liked;
    setLiked(newLiked);
    onToggle?.(newLiked);
    haptics.medium();

    animRef.current?.stop();
    if (newLiked) {
      animRef.current = Animated.sequence([
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
      ]);
    } else {
      animRef.current = Animated.spring(scale, { toValue: 1, useNativeDriver: true });
    }
    animRef.current.start(() => { animRef.current = null; });
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
