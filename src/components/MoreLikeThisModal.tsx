import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity,
  ScrollView, ActivityIndicator, Pressable,
} from 'react-native';
import { X, Sparkles, Music } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from './GlassCard';
import { TrackRow } from './TrackRow';
import { api, serverTrackToAppTrack } from '../services/apiService';
import { Track } from '../types';

type Props = {
  track: Track | null;
  onClose: () => void;
  onPlay: (tracks: Track[], index: number) => void;
};

export function MoreLikeThisModal({ track, onClose, onPlay }: Props) {
  const [similar, setSimilar] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (t: Track) => {
    setLoading(true);
    setError(null);
    setSimilar([]);
    try {
      const res = await api.getSimilarTracks(t.artist, t.title);
      const mapped = res.tracks.map(serverTrackToAppTrack);
      setSimilar(mapped);
      if (mapped.length === 0) {
        setError('No similar tracks found in your library. Try adding more music or connecting Last.fm.');
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load similar tracks');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (track) load(track);
  }, [track, load]);

  if (!track) return null;

  return (
    <Modal
      visible={!!track}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* Backdrop */}
      <Pressable style={styles.backdrop} onPress={onClose} />

      <View style={styles.sheet}>
        <LinearGradient
          colors={['rgba(59, 46, 139, 0.40)', 'rgba(13,13,20,0.98)']}
          style={StyleSheet.absoluteFill}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
        />

        {/* Handle */}
        <View style={styles.handle} />

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Sparkles size={16} color={Colors.accentPrimary} />
            <View>
              <Text style={styles.headerTitle}>More Like This</Text>
              <Text style={styles.headerSub} numberOfLines={1}>
                {track.artist} · {track.title}
              </Text>
            </View>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <X size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Content */}
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={Colors.accentPrimary} />
              <Text style={styles.loadingText}>Finding similar tracks via Last.fm…</Text>
            </View>
          ) : error ? (
            <GlassCard style={styles.emptyCard}>
              <Music size={28} color={Colors.textTertiary} />
              <Text style={styles.emptyText}>{error}</Text>
            </GlassCard>
          ) : (
            <>
              <Text style={styles.hint}>Long-press any track for more options. Tap to play.</Text>
              {similar.map((t, i) => (
                <TrackRow
                  key={`similar-${t.id}-${i}`}
                  track={t}
                  index={i + 1}
                  onPress={() => onPlay(similar, i)}
                />
              ))}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '75%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    backgroundColor: Colors.bgSecondary,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignSelf: 'center',
    marginTop: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    flex: 1,
    marginRight: Spacing.md,
  },
  headerTitle: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
  },
  headerSub: {
    ...Typography.caption,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing['2xl'],
  },
  center: {
    paddingVertical: Spacing['2xl'],
    alignItems: 'center',
    gap: Spacing.md,
  },
  loadingText: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
  },
  hint: {
    ...Typography.caption,
    color: Colors.textTertiary,
    textAlign: 'center',
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  emptyCard: {
    margin: Spacing.lg,
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.md,
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
});
