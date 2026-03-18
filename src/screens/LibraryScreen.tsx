import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, SafeAreaView,
  TouchableOpacity, Alert, ActivityIndicator,
  TextInput, Modal, RefreshControl,
} from 'react-native';
import { Plus, ScanLine, FolderOpen, ArrowUpDown } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { TrackRow } from '../components/TrackRow';
import { AlbumCard } from '../components/AlbumCard';
import { ArtistCard } from '../components/ArtistCard';
import { PlaylistCard } from '../components/PlaylistCard';
import { useLibraryStore } from '../stores/useLibraryStore';
import { usePlayerStore } from '../stores/usePlayerStore';
import { api, serverTrackToAppTrack } from '../services/apiService';
import { RootStackParamList, Track, Album, Artist, Playlist } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList>;
type LibraryTab = 'Playlists' | 'Albums' | 'Artists' | 'Liked';
type SortOption = 'a-z' | 'recent' | 'most';

const TABS: LibraryTab[] = ['Playlists', 'Albums', 'Artists', 'Liked'];
const SORT_LABELS: Record<SortOption, string> = { 'a-z': 'A–Z', recent: 'Recent', most: 'Most' };

export function LibraryScreen() {
  const navigation = useNavigation<NavProp>();
  const [activeTab, setActiveTab] = useState<LibraryTab>('Albums');
  const [sort, setSort] = useState<SortOption>('a-z');
  const [showSortMenu, setShowSortMenu] = useState(false);

  const [albums, setAlbums] = useState<Album[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [serverPlaylists, setServerPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Scan state
  const [scanDir, setScanDir] = useState('');
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<string | null>(null);

  // Create playlist modal
  const [showNewPlaylistModal, setShowNewPlaylistModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);

  const { likedTrackIds } = useLibraryStore();
  const [likedTracks, setLikedTracks] = useState<Track[]>([]);
  const { currentTrack, isPlaying, setQueue, addToQueue } = usePlayerStore();

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [albumRes, artistRes, playlistRes] = await Promise.all([
        api.getAlbums('local'),
        api.getArtists('local'),
        api.getPlaylists(),
      ]);
      setAlbums(albumRes.albums as Album[]);
      setArtists(artistRes.artists as Artist[]);
      setServerPlaylists(
        playlistRes.playlists.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          tracks: [],
          createdAt: p.created_at,
        }))
      );
    } catch (e) {
      console.warn('Library load failed:', e);
    }
    if (!silent) setLoading(false);
  }, []);

  const loadLiked = useCallback(async () => {
    if (likedTrackIds.size === 0) { setLikedTracks([]); return; }
    try {
      const r = await api.getTracks({ source: 'local', limit: 500 });
      const all = r.tracks.map(serverTrackToAppTrack);
      setLikedTracks(all.filter((t) => likedTrackIds.has(t.id)));
    } catch {}
  }, [likedTrackIds]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
  }, [loadData]);

  useEffect(() => { loadData(); }, []);
  useEffect(() => { loadLiked(); }, [loadLiked]);

  // ─── Sort helpers ─────────────────────────────────────────────────────────
  function sortedAlbums(): Album[] {
    const copy = [...albums];
    if (sort === 'a-z') return copy.sort((a, b) => a.album.localeCompare(b.album));
    if (sort === 'most') return copy.sort((a, b) => b.track_count - a.track_count);
    return copy;
  }

  function sortedArtists(): Artist[] {
    const copy = [...artists];
    if (sort === 'a-z') return copy.sort((a, b) => a.artist.localeCompare(b.artist));
    if (sort === 'most') return copy.sort((a, b) => b.track_count - a.track_count);
    return copy;
  }

  function sortedPlaylists(): Playlist[] {
    const copy = [...serverPlaylists];
    if (sort === 'a-z') return copy.sort((a, b) => a.name.localeCompare(b.name));
    if (sort === 'recent') return copy.sort((a, b) => b.createdAt - a.createdAt);
    if (sort === 'most') return copy.sort((a, b) => b.tracks.length - a.tracks.length);
    return copy;
  }

  function sortedLiked(): Track[] {
    const copy = [...likedTracks];
    if (sort === 'a-z') return copy.sort((a, b) => a.title.localeCompare(b.title));
    return copy;
  }

  // ─── Actions ──────────────────────────────────────────────────────────────
  async function handleCreatePlaylist() {
    if (!newPlaylistName.trim()) return;
    setCreatingPlaylist(true);
    try {
      await api.createPlaylist(newPlaylistName.trim());
      setNewPlaylistName('');
      setShowNewPlaylistModal(false);
      await loadData(true);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
    setCreatingPlaylist(false);
  }

  async function handleScan() {
    if (!scanDir.trim()) return;
    setScanning(true);
    setScanProgress('Starting scan…');
    try {
      await api.scanFolder(scanDir.trim());
      const poll = setInterval(async () => {
        try {
          const status = await api.getScanStatus();
          if (status.scanning) {
            setScanProgress('Scanning…');
          } else {
            clearInterval(poll);
            setScanning(false);
            setScanProgress(null);
            setShowScanModal(false);
            loadData(true);
          }
        } catch {
          clearInterval(poll);
          setScanning(false);
          setScanProgress(null);
        }
      }, 1500);
    } catch (e: any) {
      Alert.alert('Scan failed', e.message);
      setScanning(false);
      setScanProgress(null);
    }
  }

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={Colors.accentPrimary}
      colors={[Colors.accentPrimary]}
    />
  );

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['rgba(139, 92, 46, 0.20)', 'transparent']}
        style={styles.ambientWarm}
        start={{ x: 0, y: 1 }}
        end={{ x: 0.6, y: 0 }}
        pointerEvents="none"
      />

      <SafeAreaView style={styles.safeArea}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.heading}>Your Library</Text>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setShowScanModal(true)}>
            <ScanLine size={20} color={Colors.textPrimary} />
          </TouchableOpacity>
        </View>

        {/* Tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsScroll}
          contentContainerStyle={styles.tabsContent}
        >
          {TABS.map((tab) => (
            <TouchableOpacity key={tab} onPress={() => setActiveTab(tab)}>
              <GlassCard
                style={styles.tabChip}
                borderRadius={Radius.sm}
                intensity={activeTab === tab ? 60 : 25}
              >
                <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab}</Text>
              </GlassCard>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Sort bar */}
        <View style={styles.sortBar}>
          <TouchableOpacity style={styles.sortBtn} onPress={() => setShowSortMenu(!showSortMenu)}>
            <ArrowUpDown size={13} color={Colors.textSecondary} />
            <Text style={styles.sortLabel}>{SORT_LABELS[sort]}</Text>
          </TouchableOpacity>

          {showSortMenu && (
            <View style={styles.sortMenu}>
              {(Object.keys(SORT_LABELS) as SortOption[]).map((opt) => (
                <TouchableOpacity
                  key={opt}
                  style={styles.sortMenuItem}
                  onPress={() => { setSort(opt); setShowSortMenu(false); }}
                >
                  <Text style={[styles.sortMenuText, sort === opt && styles.sortMenuTextActive]}>
                    {SORT_LABELS[opt]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {loading ? (
          <ActivityIndicator color={Colors.accentPrimary} style={{ marginTop: Spacing.xl }} />
        ) : (
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            refreshControl={refreshControl}
          >
            {/* Playlists Tab */}
            {activeTab === 'Playlists' && (
              sortedPlaylists().length === 0 ? (
                <EmptyState
                  title="No playlists yet"
                  subtitle="Tap + to create a new playlist"
                  action="New Playlist"
                  onAction={() => setShowNewPlaylistModal(true)}
                />
              ) : (
                <View style={styles.grid}>
                  {sortedPlaylists().map((pl) => (
                    <PlaylistCard
                      key={pl.id}
                      playlist={pl}
                      onPress={() => navigation.navigate('PlaylistDetail', { playlist: pl })}
                    />
                  ))}
                </View>
              )
            )}

            {/* Albums Tab */}
            {activeTab === 'Albums' && (
              sortedAlbums().length === 0 ? (
                <EmptyState
                  title="No albums found"
                  action="Scan Folder"
                  onAction={() => setShowScanModal(true)}
                />
              ) : (
                <View style={styles.grid}>
                  {sortedAlbums().map((album) => (
                    <AlbumCard
                      key={`${album.album}__${album.artist}`}
                      album={album}
                      onPress={() => navigation.navigate('AlbumDetail', { album })}
                    />
                  ))}
                </View>
              )
            )}

            {/* Artists Tab */}
            {activeTab === 'Artists' && (
              sortedArtists().length === 0 ? (
                <EmptyState
                  title="No artists found"
                  action="Scan Folder"
                  onAction={() => setShowScanModal(true)}
                />
              ) : (
                <View style={styles.artistList}>
                  {sortedArtists().map((artist) => (
                    <ArtistCard
                      key={artist.artist}
                      artist={artist}
                      onPress={() => navigation.navigate('ArtistDetail', { artistName: artist.artist })}
                    />
                  ))}
                </View>
              )
            )}

            {/* Liked Songs Tab */}
            {activeTab === 'Liked' && (
              sortedLiked().length === 0 ? (
                <EmptyState
                  title="No liked songs"
                  subtitle="Tap the heart icon on any track to save it here"
                />
              ) : (
                sortedLiked().map((track, i) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={i + 1}
                    isCurrent={currentTrack?.id === track.id}
                    isPlaying={isPlaying}
                    showDownload
                    onPress={() => { setQueue(sortedLiked(), i); navigation.navigate('NowPlaying'); }}
                    onAddToQueue={(t) => addToQueue(t)}
                  />
                ))
              )
            )}
          </ScrollView>
        )}
      </SafeAreaView>

      {/* FAB — Create Playlist (Playlists tab only) */}
      {activeTab === 'Playlists' && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => setShowNewPlaylistModal(true)}
          activeOpacity={0.85}
        >
          <Plus size={24} color={Colors.textPrimary} />
        </TouchableOpacity>
      )}

      {/* Scan Modal */}
      <Modal
        visible={showScanModal}
        transparent
        animationType="fade"
        onRequestClose={() => !scanning && setShowScanModal(false)}
      >
        <View style={styles.modalOverlay}>
          <GlassCard style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <FolderOpen size={24} color={Colors.accentPrimary} />
              <Text style={styles.modalTitle}>Scan Music Folder</Text>
            </View>
            <Text style={styles.modalDesc}>Enter the full path to your FLAC/MP3 library on your Mac</Text>
            {scanning && scanProgress ? (
              <View style={styles.scanProgressRow}>
                <ActivityIndicator color={Colors.accentPrimary} size="small" />
                <Text style={styles.scanProgressText}>{scanProgress}</Text>
              </View>
            ) : (
              <TextInput
                value={scanDir}
                onChangeText={setScanDir}
                placeholder="/Users/you/Music/FLAC"
                placeholderTextColor={Colors.textTertiary}
                style={styles.dirInput}
                autoCorrect={false}
                autoCapitalize="none"
              />
            )}
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setShowScanModal(false)}
                disabled={scanning}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, scanning && styles.btnDisabled]}
                onPress={handleScan}
                disabled={scanning}
              >
                {scanning ? (
                  <ActivityIndicator color={Colors.bgPrimary} size="small" />
                ) : (
                  <Text style={styles.actionBtnText}>Scan</Text>
                )}
              </TouchableOpacity>
            </View>
          </GlassCard>
        </View>
      </Modal>

      {/* New Playlist Modal */}
      <Modal
        visible={showNewPlaylistModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNewPlaylistModal(false)}
      >
        <View style={styles.modalOverlay}>
          <GlassCard style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Plus size={24} color={Colors.accentPrimary} />
              <Text style={styles.modalTitle}>New Playlist</Text>
            </View>
            <TextInput
              value={newPlaylistName}
              onChangeText={setNewPlaylistName}
              placeholder="Playlist name"
              placeholderTextColor={Colors.textTertiary}
              style={styles.dirInput}
              autoCorrect={false}
              autoFocus
              onSubmitEditing={handleCreatePlaylist}
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => { setShowNewPlaylistModal(false); setNewPlaylistName(''); }}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, creatingPlaylist && styles.btnDisabled]}
                onPress={handleCreatePlaylist}
                disabled={creatingPlaylist}
              >
                {creatingPlaylist ? (
                  <ActivityIndicator color={Colors.bgPrimary} size="small" />
                ) : (
                  <Text style={styles.actionBtnText}>Create</Text>
                )}
              </TouchableOpacity>
            </View>
          </GlassCard>
        </View>
      </Modal>
    </View>
  );
}

function EmptyState({ icon, title, subtitle, action, onAction }: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <GlassCard style={styles.emptyState}>
      {icon}
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle && <Text style={styles.emptyText}>{subtitle}</Text>}
      {action && onAction && (
        <TouchableOpacity onPress={onAction} style={styles.emptyBtn}>
          <Text style={styles.emptyBtnText}>{action}</Text>
        </TouchableOpacity>
      )}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
  ambientWarm: { position: 'absolute', bottom: 0, left: 0, width: '70%', height: '60%' },
  safeArea: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, marginTop: Spacing.lg, marginBottom: Spacing.md,
  },
  heading: { ...Typography.headingXl, color: Colors.textPrimary },
  iconBtn: { padding: Spacing.sm },

  tabsScroll: { flexGrow: 0 },
  tabsContent: { paddingHorizontal: Spacing.lg, gap: Spacing.sm },
  tabChip: { marginBottom: Spacing.md },
  tabText: {
    ...Typography.bodySm, color: Colors.textSecondary,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
  },
  tabTextActive: { color: Colors.textPrimary },

  sortBar: {
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    zIndex: 10,
  },
  sortBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: Spacing.xs, paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm,
    backgroundColor: Colors.glassBg,
    borderWidth: 1, borderColor: Colors.glassBorder,
  },
  sortLabel: { ...Typography.caption, color: Colors.textSecondary },
  sortMenu: {
    marginTop: 4,
    backgroundColor: Colors.bgSecondary,
    borderWidth: 1, borderColor: Colors.glassBorder,
    borderRadius: Radius.md,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    minWidth: 100,
  },
  sortMenuItem: { paddingHorizontal: Spacing.lg, paddingVertical: Spacing.sm + 2 },
  sortMenuText: { ...Typography.bodySm, color: Colors.textSecondary },
  sortMenuTextActive: { color: Colors.accentPrimary, fontWeight: '600' },

  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing['3xl'] + 80 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  artistList: {},

  emptyState: { padding: Spacing.xl, alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.xl },
  emptyTitle: { ...Typography.headingSm, color: Colors.textPrimary, marginTop: Spacing.sm },
  emptyText: { ...Typography.body, color: Colors.textSecondary, textAlign: 'center' },
  emptyBtn: {
    marginTop: Spacing.md,
    backgroundColor: Colors.accentPrimary,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.full,
  },
  emptyBtnText: { ...Typography.headingSm, color: Colors.bgPrimary },

  fab: {
    position: 'absolute',
    bottom: 100,
    right: Spacing.xl,
    width: 56, height: 56,
    borderRadius: Radius.full,
    backgroundColor: Colors.accentPrimary,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: Colors.accentPrimary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 12,
    elevation: 8,
  },

  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center', alignItems: 'center', padding: Spacing.xl,
  },
  modalCard: { padding: Spacing.xl, width: '100%' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.md },
  modalTitle: { ...Typography.headingMd, color: Colors.textPrimary },
  modalDesc: { ...Typography.body, color: Colors.textSecondary, marginBottom: Spacing.lg },
  dirInput: {
    ...Typography.body, color: Colors.textPrimary,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: Colors.glassBorder,
    borderRadius: Radius.md, padding: Spacing.md,
    marginBottom: Spacing.lg,
  },
  scanProgressRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    padding: Spacing.md, marginBottom: Spacing.lg,
  },
  scanProgressText: { ...Typography.body, color: Colors.textSecondary },
  modalBtns: { flexDirection: 'row', gap: Spacing.md },
  cancelBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    height: 44, borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: Colors.glassBorder,
  },
  cancelBtnText: { ...Typography.headingSm, color: Colors.textSecondary },
  actionBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    height: 44, borderRadius: Radius.full,
    backgroundColor: Colors.accentPrimary,
  },
  actionBtnText: { ...Typography.headingSm, color: Colors.bgPrimary },
  btnDisabled: { opacity: 0.6 },
});
