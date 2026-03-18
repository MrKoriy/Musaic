import React from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Music } from 'lucide-react-native';
import { Colors, Radius, Spacing, Typography } from '../theme';
import { Album } from '../types';

interface Props {
  album: Album;
  onPress: () => void;
}

export function AlbumCard({ album, onPress }: Props) {
  return (
    <TouchableOpacity style={styles.container} onPress={onPress} activeOpacity={0.8}>
      {album.cover_url ? (
        <Image source={{ uri: album.cover_url }} style={styles.artwork} />
      ) : (
        <View style={[styles.artwork, styles.placeholder]}>
          <Music size={28} color={Colors.textTertiary} />
        </View>
      )}
      <Text style={styles.name} numberOfLines={2}>{album.album}</Text>
      <Text style={styles.artist} numberOfLines={1}>{album.artist}</Text>
      <Text style={styles.meta}>{album.track_count} tracks</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '47%',
    marginBottom: Spacing.lg,
  },
  artwork: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: Radius.lg,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.bgTertiary,
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    ...Typography.bodySm,
    color: Colors.textPrimary,
    fontWeight: '600',
  },
  artist: {
    ...Typography.caption,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  meta: {
    ...Typography.caption,
    color: Colors.textTertiary,
    marginTop: 1,
  },
});
