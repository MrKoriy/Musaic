import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, ScrollView,
  ActivityIndicator, Alert,
} from 'react-native';
import { Plus, X, Music2 } from 'lucide-react-native';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from './GlassCard';
import { api, ServerPlaylist } from '../services/apiService';
import { Track } from '../types';
import { haptics } from '../utils/haptics';

type Props = {
  visible: boolean;
  track: Track | null;
  onClose: () => void;
};

export function PlaylistPicker({ visible, track, onClose }: Props) {
  const [playlists, setPlaylists] = useState<ServerPlaylist[]>([]);
  const [loading, setLoading] = useState(false);
  const [showNewPlaylist, setShowNewPlaylist] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (visible) {
      setLoading(true);
      api.getPlaylists()
        .then((res) => setPlaylists(res.playlists))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [visible]);

  async function handleSelect(playlistId: string) {
    if (!track) return;
    try {
      await api.addToPlaylist(playlistId, track.id);
      haptics.medium();
      onClose();
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Failed to add track to playlist');
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      const res = await api.createPlaylist(newName.trim());
      if (track) {
        await api.addToPlaylist(res.id, track.id);
      }
      haptics.medium();
      setNewName('');
      setShowNewPlaylist(false);
      onClose();
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Failed to create playlist');
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}}>
          <GlassCard style={styles.card}>
            <View style={styles.header}>
              <Text style={styles.title}>Add to Playlist</Text>
              <TouchableOpacity onPress={onClose}>
                <X size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {track && (
              <Text style={styles.trackInfo} numberOfLines={1}>
                {track.artist} — {track.title}
              </Text>
            )}

            {loading ? (
              <ActivityIndicator color={Colors.accentPrimary} style={{ marginVertical: Spacing.lg }} />
            ) : (
              <ScrollView style={styles.list} bounces={false}>
                {playlists.map((pl) => (
                  <TouchableOpacity
                    key={pl.id}
                    style={styles.row}
                    onPress={() => handleSelect(pl.id)}
                  >
                    <Music2 size={16} color={Colors.textSecondary} />
                    <Text style={styles.playlistName} numberOfLines={1}>{pl.name}</Text>
                    <Text style={styles.count}>{pl.track_count}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            {showNewPlaylist ? (
              <View style={styles.newRow}>
                <TextInput
                  style={styles.input}
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="Playlist name"
                  placeholderTextColor={Colors.textTertiary}
                  autoFocus
                  onSubmitEditing={handleCreate}
                />
                <TouchableOpacity onPress={handleCreate} style={styles.createBtn}>
                  <Text style={styles.createBtnText}>Create</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.newPlaylistBtn}
                onPress={() => setShowNewPlaylist(true)}
              >
                <Plus size={16} color={Colors.accentPrimary} />
                <Text style={styles.newPlaylistText}>New Playlist</Text>
              </TouchableOpacity>
            )}
          </GlassCard>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  card: {
    padding: Spacing.lg,
    width: '100%',
    maxHeight: 400,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  title: {
    ...Typography.headingMd,
    color: Colors.textPrimary,
  },
  trackInfo: {
    ...Typography.bodySm,
    color: Colors.textTertiary,
    marginBottom: Spacing.md,
  },
  list: {
    maxHeight: 220,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm + 2,
    paddingHorizontal: Spacing.sm,
    gap: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.glassBorder,
  },
  playlistName: {
    ...Typography.body,
    color: Colors.textPrimary,
    flex: 1,
  },
  count: {
    ...Typography.caption,
    color: Colors.textTertiary,
  },
  newPlaylistBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
  },
  newPlaylistText: {
    ...Typography.body,
    color: Colors.accentPrimary,
    fontWeight: '600',
  },
  newRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  input: {
    flex: 1,
    ...Typography.body,
    color: Colors.textPrimary,
    backgroundColor: Colors.glassBgActive,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  createBtn: {
    backgroundColor: Colors.accentPrimary,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
  },
  createBtnText: {
    ...Typography.bodySm,
    color: Colors.bgPrimary,
    fontWeight: '600',
  },
});
