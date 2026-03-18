import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, SafeAreaView,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { ChevronDown, Play, Shuffle, Music } from 'lucide-react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { TrackRow } from '../components/TrackRow';
import { usePlayerStore } from '../stores/usePlayerStore';
import { api, serverTrackToAppTrack } from '../services/apiService';
import { RootStackParamList, Track } from '../types';
import { formatDuration } from '../data/mockData';

type RouteP = RouteProp<RootStackParamList, 'PlaylistDetail'>;
type NavProp = NativeStackNavigationProp<RootStackParamList>;

export function PlaylistDetailScreen() {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RouteP>();
  const { playlist } = route.params;
  const { currentTrack, isPlaying, setQueue, addToQueue } = usePlayerStore();

  const [tracks, setTracks] = useState<Track[]>(playlist.tracks);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Load tracks from server for server-side playlists
    if (playlist.id.startsWith('playlist_') && playlist.tracks.length === 0) {
      setLoading(true);
      api.getPlaylistTracks(playlist.id)
        .then((res) => setTracks(res.tracks.map(serverTrackToAppTrack)))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [playlist.id]);

  async function playAll(shuffled = false) {
    if (tracks.length === 0) return;
    const list = shuffled ? [...tracks].sort(() => Math.random() - 0.5) : tracks;
    await setQueue(list, 0);
    navigation.navigate('NowPlaying');
  }

  const totalDuration = tracks.reduce((s, t) => s + (t.duration ?? 0), 0);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['rgba(139, 92, 46, 0.25)', 'transparent']}
        style={styles.ambientWarm}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        pointerEvents="none"
      />
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => navigation.goBack()}>
              <ChevronDown size={24} color={Colors.textPrimary} />
            </TouchableOpacity>
          </View>

          {/* Hero */}
          <GlassCard style={styles.heroCard} borderRadius={Radius.xl} intensity={50}>
            <View style={styles.heroInner}>
              <View style={styles.heroArtwork}>
                <Music size={48} color={Colors.textTertiary} />
              </View>
              <Text style={styles.playlistName}>{playlist.name}</Text>
              <Text style={styles.playlistMeta}>
                {tracks.length} tracks{totalDuration > 0 ? ` · ${formatDuration(totalDuration)}` : ''}
              </Text>
              <View style={styles.ctrlRow}>
                <TouchableOpacity style={styles.playButton} onPress={() => playAll(false)}>
                  <Play size={18} color={Colors.bgPrimary} fill={Colors.bgPrimary} />
                  <Text style={styles.playBtnText}>Play</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.shuffleButton} onPress={() => playAll(true)}>
                  <Shuffle size={18} color={Colors.textPrimary} />
                  <Text style={styles.shuffleBtnText}>Shuffle</Text>
                </TouchableOpacity>
              </View>
            </View>
          </GlassCard>

          {/* Track List */}
          {loading ? (
            <ActivityIndicator color={Colors.accentPrimary} style={{ marginTop: Spacing.xl }} />
          ) : tracks.length === 0 ? (
            <GlassCard style={styles.emptyState}>
              <Text style={styles.emptyText}>No tracks in this playlist</Text>
            </GlassCard>
          ) : (
            tracks.map((track, idx) => (
              <TrackRow
                key={track.id}
                track={track}
                index={idx + 1}
                isCurrent={currentTrack?.id === track.id}
                isPlaying={isPlaying}
                onPress={() => { setQueue(tracks, idx); navigation.navigate('NowPlaying'); }}
                onAddToQueue={(t) => addToQueue(t)}
              />
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
  ambientWarm: { position: 'absolute', top: 0, left: 0, width: '100%', height: '40%' },
  safeArea: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing['3xl'] },
  header: { paddingTop: Spacing.md, marginBottom: Spacing.lg },
  heroCard: { marginBottom: Spacing.xl },
  heroInner: { alignItems: 'center', padding: Spacing.xl },
  heroArtwork: {
    width: 140, height: 140, borderRadius: Radius.lg,
    backgroundColor: Colors.bgTertiary, alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  playlistName: { ...Typography.headingMd, color: Colors.textPrimary, marginBottom: Spacing.xs },
  playlistMeta: { ...Typography.bodySm, color: Colors.textSecondary, marginBottom: Spacing.lg },
  ctrlRow: { flexDirection: 'row', gap: Spacing.md, width: '100%' },
  playButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, height: 46, borderRadius: Radius.full, backgroundColor: Colors.accentPrimary,
  },
  playBtnText: { ...Typography.headingSm, color: Colors.bgPrimary },
  shuffleButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm, height: 46, borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: Colors.glassBorder,
  },
  shuffleBtnText: { ...Typography.headingSm, color: Colors.textPrimary },
  emptyState: { padding: Spacing.xl, alignItems: 'center' },
  emptyText: { ...Typography.body, color: Colors.textSecondary },
});
