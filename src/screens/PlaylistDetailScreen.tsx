import React, { useEffect, useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, SafeAreaView,
  TouchableOpacity, ActivityIndicator, Image,
} from 'react-native';
import { ChevronDown, Play, Shuffle, Music, Pencil, Share2 } from 'lucide-react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { TrackRow } from '../components/TrackRow';
import { PlaylistEditor } from '../components/PlaylistEditor';
import { usePlayerStore } from '../stores/usePlayerStore';
import { api, serverTrackToAppTrack, resolveServerUrl } from '../services/apiService';
import { RootStackParamList, Track } from '../types';
import { sharePlaylist } from '../utils/share';
import { formatDuration } from '../data/mockData';

type RouteP = RouteProp<RootStackParamList, 'PlaylistDetail'>;
type NavProp = NativeStackNavigationProp<RootStackParamList>;

type SortKey = 'default' | 'title' | 'artist' | 'duration';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'default', label: 'Default' },
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'duration', label: 'Duration' },
];

function CoverGrid({ urls, size }: { urls: string[]; size: number }) {
  const half = (size - 2) / 2;

  if (urls.length === 0) {
    return (
      <View style={[styles.artworkFallback, { width: size, height: size }]}>
        <Music size={48} color={Colors.textTertiary} />
      </View>
    );
  }

  if (urls.length === 1) {
    return (
      <Image
        source={{ uri: resolveServerUrl(urls[0]!) }}
        style={{ width: size, height: size, borderRadius: Radius.lg }}
      />
    );
  }

  const cells = urls.slice(0, 4);
  return (
    <View style={{ width: size, height: size, borderRadius: Radius.lg, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', gap: 2 }}>
        {cells.slice(0, 2).map((url, i) => (
          <Image key={i} source={{ uri: resolveServerUrl(url) }} style={{ width: half, height: half }} />
        ))}
      </View>
      {cells.length > 2 && (
        <View style={{ flexDirection: 'row', gap: 2, marginTop: 2 }}>
          {cells.slice(2).map((url, i) => (
            <Image key={i} source={{ uri: resolveServerUrl(url) }} style={{ width: half, height: half }} />
          ))}
        </View>
      )}
    </View>
  );
}

export function PlaylistDetailScreen() {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RouteP>();
  const { playlist } = route.params;
  const { currentTrack, isPlaying, setQueue, addToQueue } = usePlayerStore();

  const [tracks, setTracks] = useState<Track[]>(playlist.tracks);
  const [loading, setLoading] = useState(false);
  const [coverUrls, setCoverUrls] = useState<string[]>([]);
  const [playlistName, setPlaylistName] = useState(playlist.name);
  const [playlistDescription, setPlaylistDescription] = useState(playlist.description ?? '');
  const [editorVisible, setEditorVisible] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);

  useEffect(() => {
    // Always load tracks from server for playlists with empty track arrays
    if (playlist.tracks.length === 0) {
      setLoading(true);
      api.getPlaylistTracks(playlist.id)
        .then((res) => setTracks(res.tracks.map(serverTrackToAppTrack)))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
    api.getPlaylistCovers(playlist.id)
      .then((res) => setCoverUrls(res.covers))
      .catch(() => {});
  }, [playlist.id]);

  const sortedTracks = useMemo(() => {
    if (sortKey === 'default') return tracks;
    return [...tracks].sort((a, b) => {
      if (sortKey === 'title') return (a.title ?? '').localeCompare(b.title ?? '');
      if (sortKey === 'artist') return (a.artist ?? '').localeCompare(b.artist ?? '');
      if (sortKey === 'duration') return (a.duration ?? 0) - (b.duration ?? 0);
      return 0;
    });
  }, [tracks, sortKey]);

  async function playAll(shuffled = false) {
    if (sortedTracks.length === 0) return;
    const list = shuffled ? [...sortedTracks].sort(() => Math.random() - 0.5) : sortedTracks;
    await setQueue(list, 0);
    navigation.navigate('NowPlaying');
  }

  const totalDuration = tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const activeSortLabel = SORT_OPTIONS.find((o) => o.key === sortKey)?.label ?? 'Default';

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
            <View style={styles.headerActions}>
              <TouchableOpacity onPress={() => sharePlaylist(playlistName, tracks)} hitSlop={8}>
                <Share2 size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setEditorVisible(true)} hitSlop={8}>
                <Pencil size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Hero */}
          <GlassCard style={styles.heroCard} borderRadius={Radius.xl} intensity={50}>
            <View style={styles.heroInner}>
              <CoverGrid urls={coverUrls} size={140} />
              <Text style={styles.playlistName}>{playlistName}</Text>
              {playlistDescription ? (
                <Text style={styles.playlistDesc} numberOfLines={2}>{playlistDescription}</Text>
              ) : null}
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

          {/* Sort bar */}
          {tracks.length > 1 && (
            <View style={styles.sortBar}>
              <TouchableOpacity
                style={styles.sortButton}
                onPress={() => setSortMenuOpen((v) => !v)}
              >
                <Text style={styles.sortLabel}>Sort: {activeSortLabel} ▾</Text>
              </TouchableOpacity>
              {sortMenuOpen && (
                <GlassCard style={styles.sortMenu} borderRadius={Radius.md} intensity={60}>
                  {SORT_OPTIONS.map((opt) => (
                    <TouchableOpacity
                      key={opt.key}
                      style={styles.sortOption}
                      onPress={() => { setSortKey(opt.key); setSortMenuOpen(false); }}
                    >
                      <Text style={[
                        styles.sortOptionText,
                        sortKey === opt.key && styles.sortOptionActive,
                      ]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </GlassCard>
              )}
            </View>
          )}

          {/* Track List */}
          {loading ? (
            <ActivityIndicator color={Colors.accentPrimary} style={{ marginTop: Spacing.xl }} />
          ) : sortedTracks.length === 0 ? (
            <GlassCard style={styles.emptyState}>
              <Text style={styles.emptyText}>No tracks in this playlist</Text>
            </GlassCard>
          ) : (
            sortedTracks.map((track, idx) => (
              <TrackRow
                key={track.id}
                track={track}
                index={idx + 1}
                isCurrent={currentTrack?.id === track.id}
                isPlaying={isPlaying}
                onPress={() => { setQueue(sortedTracks, idx); navigation.navigate('NowPlaying'); }}
                onAddToQueue={(t) => addToQueue(t)}
              />
            ))
          )}
        </ScrollView>
      </SafeAreaView>

      <PlaylistEditor
        visible={editorVisible}
        playlistId={playlist.id}
        initialName={playlistName}
        initialDescription={playlistDescription}
        onClose={() => setEditorVisible(false)}
        onSaved={(name, desc) => {
          setPlaylistName(name);
          setPlaylistDescription(desc);
          setEditorVisible(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
  ambientWarm: { position: 'absolute', top: 0, left: 0, width: '100%', height: '40%' },
  safeArea: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing['3xl'] },
  header: {
    paddingTop: Spacing.md,
    marginBottom: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  heroCard: { marginBottom: Spacing.xl },
  heroInner: { alignItems: 'center', padding: Spacing.xl },
  artworkFallback: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  playlistName: {
    ...Typography.headingMd,
    color: Colors.textPrimary,
    marginBottom: Spacing.xs,
    marginTop: Spacing.lg,
    textAlign: 'center',
  },
  playlistDesc: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
    marginBottom: Spacing.xs,
    textAlign: 'center',
  },
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
  sortBar: { marginBottom: Spacing.md, position: 'relative', zIndex: 10 },
  sortButton: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.xs,
    paddingHorizontal: Spacing.sm,
  },
  sortLabel: { ...Typography.caption, color: Colors.textSecondary },
  sortMenu: {
    position: 'absolute',
    top: 28,
    left: 0,
    minWidth: 140,
  },
  sortOption: { paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md },
  sortOptionText: { ...Typography.body, color: Colors.textSecondary },
  sortOptionActive: { color: Colors.accentPrimary, fontWeight: '600' },
  emptyState: { padding: Spacing.xl, alignItems: 'center' },
  emptyText: { ...Typography.body, color: Colors.textSecondary },
});
