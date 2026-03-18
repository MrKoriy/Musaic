import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Colors, Radius, Spacing, Typography } from '../theme';
import { Artist } from '../types';

interface Props {
  artist: Artist;
  onPress: () => void;
}

const AVATAR_COLORS = [
  '#e91e8c', '#7c3aed', '#2563eb', '#0891b2',
  '#059669', '#d97706', '#dc2626',
];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export function ArtistCard({ artist, onPress }: Props) {
  const initial = artist.artist.charAt(0).toUpperCase();
  const color = avatarColor(artist.artist);

  return (
    <TouchableOpacity style={styles.container} onPress={onPress} activeOpacity={0.8}>
      <View style={[styles.avatar, { backgroundColor: color + '33', borderColor: color + '55' }]}>
        <Text style={[styles.initial, { color }]}>{initial}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>{artist.artist}</Text>
        <Text style={styles.meta}>
          {artist.album_count} {artist.album_count === 1 ? 'album' : 'albums'} · {artist.track_count} tracks
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.glassBorder,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: Radius.full,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    fontSize: 22,
    fontWeight: '700',
  },
  info: {
    flex: 1,
  },
  name: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
  },
  meta: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
});
