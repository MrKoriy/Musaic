import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Music } from 'lucide-react-native';
import { Colors, Radius, Spacing, Typography } from '../theme';
import { Playlist } from '../types';

interface Props {
  playlist: Playlist;
  onPress: () => void;
}

export function PlaylistCard({ playlist, onPress }: Props) {
  return (
    <TouchableOpacity style={styles.container} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.artwork}>
        <Music size={28} color={Colors.textTertiary} />
      </View>
      <Text style={styles.name} numberOfLines={2}>{playlist.name}</Text>
      <Text style={styles.meta}>{playlist.tracks.length} tracks</Text>
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
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  name: {
    ...Typography.bodySm,
    color: Colors.textPrimary,
    fontWeight: '600',
  },
  meta: {
    ...Typography.caption,
    color: Colors.textTertiary,
    marginTop: 2,
  },
});
