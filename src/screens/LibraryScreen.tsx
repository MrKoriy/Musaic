import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, SafeAreaView,
  TouchableOpacity, Image, Alert, ActivityIndicator,
  TextInput, Modal,
} from 'react-native';
import { Plus, Music, ScanLine, FolderOpen, Download, Trash2 } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { TrackRow } from '../components/TrackRow';
import { DownloadButton } from '../components/DownloadButton';
import { useLibraryStore } from '../stores/useLibraryStore';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useDownloadStore } from '../stores/useDownloadStore';
import { api, serverTrackToAppTrack } from '../services/apiService';
import { RootStackParamList, Track, Album } from '../types';
import { formatDuration } from '../data/mockData';
import { formatBytes } from '../services/downloadService';

type NavProp = NativeStackNavigationProp<RootStackParamList>;
type LibraryTab = 'Tracks' | 'Albums' | 'Playlists' | 'Downloads';

export function LibraryScreen() {
  const navigation = useNavigation<NavProp>();
  const [activeTab, setActiveTab] = useState<LibraryTab>('Albums');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [serverPlaylists, setServerPlaylists] = useState<import('../types').Playlist[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanDir, setScanDir] = useState('');
  const [showScanModal, setShowScanModal] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [showNewPlaylistModal, setShowNewPlaylistModal] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);

  const { currentTrack, isPlaying, setQueue, addToQueue } = usePlayerStore();
  const { downloads, totalStorageBytes, removeDownload, clearAllDownloads, isOffline, refreshDownloads } = useDownloadStore();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [trackRes, albumRes, playlistRes] = await Promise.all([
        api.getTracks({ source: 'local', limit: 200 }),
        api.getAlbums('local'),
        api.getPlaylists(),
      ]);
      setTracks(trackRes.tracks.map(serverTrackToAppTrack));
      setAlbums(albumRes.albums as Album[]);
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
    setLoading(false);
  }, []);

  async function handleCreatePlaylist() {
    if (!newPlaylistName.trim()) return;
    setCreatingPlaylist(true);
    try {
      await api.createPlaylist(newPlaylistName.trim());
      setNewPlaylistName('');
      setShowNewPlaylistModal(false);
      loadData();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    }
    setCreatingPlaylist(false);
  }

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (activeTab === 'Downloads') refreshDownloads();
  }, [activeTab, refreshDownloads]);

  async function handleScan() {
    if (!scanDir.trim()) return;
    setScanning(true);
    try {
      await api.scanFolder(scanDir.trim());
      setShowScanModal(false);
      // Poll for completion
      const poll = setInterval(async () => {
        const status = await api.getScanStatus();
        if (!status.scanning) {
          clearInterval(poll);
          setScanning(false);
          loadData();
        }
      }, 1500);
    } catch (e: any) {
      Alert.alert('Scan failed', e.message);
      setScanning(false);
    }
  }

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
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.heading}>Your Library</Text>
            <View style={{ flexDirection: 'row', gap: Spacing.sm }}>
              {activeTab === 'Playlists' && (
                <TouchableOpacity style={styles.iconBtn} onPress={() => setShowNewPlaylistModal(true)}>
                  <Plus size={20} color={Colors.textPrimary} />
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.iconBtn} onPress={() => setShowScanModal(true)}>
                <ScanLine size={20} color={Colors.textPrimary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Offline indicator */}
          {isOffline && (
            <View style={styles.offlineBanner}>
              <Text style={styles.offlineText}>Offline — showing downloads only</Text>
            </View>
          )}

          {/* Filter Tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll}>
            {(['Tracks', 'Albums', 'Playlists', 'Downloads'] as LibraryTab[]).map((tab) => (
              <TouchableOpacity key={tab} onPress={() => setActiveTab(tab)}>
                <GlassCard style={styles.tabChip} borderRadius={Radius.sm} intensity={activeTab === tab ? 60 : 30}>
                  <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>{tab}</Text>
                </GlassCard>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {loading ? (
            <ActivityIndicator color={Colors.accentPrimary} style={{ marginTop: Spacing.xl }} />
          ) : (
            <>
              {/* Tracks Tab */}
              {activeTab === 'Tracks' && (
                tracks.length === 0 ? (
                  <EmptyState onScan={() => setShowScanModal(true)} />
                ) : (
                  tracks.map((track, i) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      index={i + 1}
                      isCurrent={currentTrack?.id === track.id}
                      isPlaying={isPlaying}
                      showDownload
                      onPress={() => { setQueue(tracks, i); navigation.navigate('NowPlaying'); }}
                      onAddToQueue={(t) => addToQueue(t)}
                    />
                  ))
                )
              )}

              {/* Albums Tab */}
              {activeTab === 'Albums' && (
                albums.length === 0 ? (
                  <EmptyState onScan={() => setShowScanModal(true)} />
                ) : (
                  <View style={styles.albumGrid}>
                    {albums.map((album) => (
                      <TouchableOpacity
                        key={`${album.album}__${album.artist}`}
                        style={styles.albumCard}
                        activeOpacity={0.8}
                        onPress={() => navigation.navigate('AlbumDetail', { album })}
                      >
                        {album.cover_url ? (
                          <Image source={{ uri: album.cover_url }} style={styles.albumArt} />
                        ) : (
                          <View style={[styles.albumArt, styles.albumArtPlaceholder]}>
                            <Music size={28} color={Colors.textTertiary} />
                          </View>
                        )}
                        <Text style={styles.albumName} numberOfLines={2}>{album.album}</Text>
                        <Text style={styles.albumArtist} numberOfLines={1}>{album.artist}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )
              )}

              {/* Playlists Tab */}
              {activeTab === 'Playlists' && (
                serverPlaylists.length === 0 ? (
                  <GlassCard style={styles.emptyState}>
                    <Plus size={32} color={Colors.textTertiary} />
                    <Text style={styles.emptyTitle}>No playlists yet</Text>
                    <Text style={styles.emptyText}>Tap + to create a new playlist</Text>
                  </GlassCard>
                ) : (
                  serverPlaylists.map((playlist) => (
                    <TouchableOpacity
                      key={playlist.id}
                      activeOpacity={0.8}
                      onPress={() => navigation.navigate('PlaylistDetail', { playlist })}
                    >
                      <GlassCard style={styles.playlistItem}>
                        <View style={styles.playlistRow}>
                          <View style={styles.artworkPlaceholder}>
                            <Music size={20} color={Colors.textTertiary} />
                          </View>
                          <View style={styles.playlistInfo}>
                            <Text style={styles.playlistName}>{playlist.name}</Text>
                            <Text style={styles.playlistMeta}>{playlist.tracks.length} tracks · Playlist</Text>
                          </View>
                        </View>
                      </GlassCard>
                    </TouchableOpacity>
                  ))
                )
              )}

              {/* Downloads Tab */}
              {activeTab === 'Downloads' && (
                <>
                  {/* Storage header */}
                  <GlassCard style={styles.storageCard}>
                    <View style={styles.storageRow}>
                      <View>
                        <Text style={styles.storageTitle}>Downloaded Music</Text>
                        <Text style={styles.storageMeta}>
                          {downloads.length} tracks · {formatBytes(totalStorageBytes)}
                        </Text>
                      </View>
                      {downloads.length > 0 && (
                        <TouchableOpacity
                          onPress={() =>
                            Alert.alert(
                              'Clear Downloads',
                              'Remove all downloaded tracks from this device?',
                              [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Clear All', style: 'destructive', onPress: clearAllDownloads },
                              ]
                            )
                          }
                          style={styles.clearBtn}
                        >
                          <Trash2 size={16} color={Colors.textTertiary} />
                          <Text style={styles.clearBtnText}>Clear All</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </GlassCard>

                  {downloads.length === 0 ? (
                    <GlassCard style={styles.emptyState}>
                      <Download size={32} color={Colors.textTertiary} />
                      <Text style={styles.emptyTitle}>No downloads yet</Text>
                      <Text style={styles.emptyText}>
                        Tap the download icon on any track to save it for offline listening
                      </Text>
                    </GlassCard>
                  ) : (
                    downloads.map((record, i) => {
                      const track: Track = {
                        id: record.trackId,
                        title: record.title,
                        artist: record.artist,
                        album: record.album,
                        artwork: record.artwork,
                        url: record.localUri,
                        source: record.source as Track['source'],
                      };
                      return (
                        <TrackRow
                          key={record.trackId}
                          track={track}
                          index={i + 1}
                          isCurrent={currentTrack?.id === record.trackId}
                          isPlaying={isPlaying}
                          onPress={() => {
                            setQueue([track], 0);
                            navigation.navigate('NowPlaying');
                          }}
                          onAddToQueue={(t) => addToQueue(t)}
                        />
                      );
                    })
                  )}
                </>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>

      {/* Scan Modal */}
      <Modal visible={showScanModal} transparent animationType="fade" onRequestClose={() => setShowScanModal(false)}>
        <View style={styles.modalOverlay}>
          <GlassCard style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <FolderOpen size={24} color={Colors.accentPrimary} />
              <Text style={styles.modalTitle}>Scan Music Folder</Text>
            </View>
            <Text style={styles.modalDesc}>Enter the full path to your FLAC/MP3 library on your Mac</Text>
            <TextInput
              value={scanDir}
              onChangeText={setScanDir}
              placeholder="/Users/you/Music/FLAC"
              placeholderTextColor={Colors.textTertiary}
              style={styles.dirInput}
              autoCorrect={false}
              autoCapitalize="none"
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowScanModal(false)}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.scanBtn, scanning && { opacity: 0.6 }]}
                onPress={handleScan}
                disabled={scanning}
              >
                {scanning ? (
                  <ActivityIndicator color={Colors.bgPrimary} size="small" />
                ) : (
                  <Text style={styles.scanBtnText}>Scan</Text>
                )}
              </TouchableOpacity>
            </View>
          </GlassCard>
        </View>
      </Modal>

      {/* New Playlist Modal */}
      <Modal visible={showNewPlaylistModal} transparent animationType="fade" onRequestClose={() => setShowNewPlaylistModal(false)}>
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
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => { setShowNewPlaylistModal(false); setNewPlaylistName(''); }}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.scanBtn, creatingPlaylist && { opacity: 0.6 }]}
                onPress={handleCreatePlaylist}
                disabled={creatingPlaylist}
              >
                {creatingPlaylist ? (
                  <ActivityIndicator color={Colors.bgPrimary} size="small" />
                ) : (
                  <Text style={styles.scanBtnText}>Create</Text>
                )}
              </TouchableOpacity>
            </View>
          </GlassCard>
        </View>
      </Modal>
    </View>
  );
}

function EmptyState({ onScan }: { onScan: () => void }) {
  return (
    <GlassCard style={{ padding: Spacing.xl, alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.xl }}>
      <Music size={32} color={Colors.textTertiary} />
      <Text style={{ ...Typography.headingSm, color: Colors.textPrimary, marginTop: Spacing.sm }}>
        No music yet
      </Text>
      <Text style={{ ...Typography.body, color: Colors.textSecondary, textAlign: 'center' }}>
        Scan a local FLAC folder to get started
      </Text>
      <TouchableOpacity
        onPress={onScan}
        style={{
          marginTop: Spacing.md,
          backgroundColor: Colors.accentPrimary,
          paddingHorizontal: Spacing.xl,
          paddingVertical: Spacing.sm + 2,
          borderRadius: Radius.full,
          flexDirection: 'row',
          gap: Spacing.sm,
          alignItems: 'center',
        }}
      >
        <ScanLine size={16} color={Colors.bgPrimary} />
        <Text style={{ ...Typography.headingSm, color: Colors.bgPrimary }}>Scan Folder</Text>
      </TouchableOpacity>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
  ambientWarm: { position: 'absolute', bottom: 0, left: 0, width: '70%', height: '60%' },
  safeArea: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing['3xl'] },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: Spacing.lg, marginBottom: Spacing.xl,
  },
  heading: { ...Typography.headingXl, color: Colors.textPrimary },
  iconBtn: { padding: Spacing.sm },
  tabsScroll: { marginBottom: Spacing.lg },
  tabChip: { marginRight: Spacing.sm },
  tabText: {
    ...Typography.bodySm, color: Colors.textSecondary,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs + 2,
  },
  tabTextActive: { color: Colors.textPrimary },
  emptyState: { padding: Spacing.xl, alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.xl },
  emptyTitle: { ...Typography.headingSm, color: Colors.textPrimary, marginTop: Spacing.sm },
  emptyText: { ...Typography.body, color: Colors.textSecondary, textAlign: 'center' },

  // Album grid
  albumGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.md },
  albumCard: { width: '47%' },
  albumArt: { width: '100%', aspectRatio: 1, borderRadius: Radius.lg, marginBottom: Spacing.sm },
  albumArtPlaceholder: {
    backgroundColor: Colors.bgTertiary, alignItems: 'center', justifyContent: 'center',
  },
  albumName: { ...Typography.bodySm, color: Colors.textPrimary, fontWeight: '600' },
  albumArtist: { ...Typography.caption, color: Colors.textSecondary, marginTop: 2 },

  // Playlists
  playlistItem: { marginBottom: Spacing.sm },
  playlistRow: { flexDirection: 'row', alignItems: 'center', padding: Spacing.md, gap: Spacing.md },
  artworkPlaceholder: {
    width: 48, height: 48, borderRadius: Radius.sm,
    backgroundColor: Colors.glassBgActive, alignItems: 'center', justifyContent: 'center',
  },
  playlistInfo: { flex: 1 },
  playlistName: { ...Typography.body, color: Colors.textPrimary, fontWeight: '600' },
  playlistMeta: { ...Typography.bodySm, color: Colors.textSecondary, marginTop: 2 },

  // Offline banner
  offlineBanner: {
    backgroundColor: 'rgba(124,58,237,0.2)',
    borderWidth: 1, borderColor: Colors.accentPurple,
    borderRadius: Radius.sm, padding: Spacing.sm,
    marginBottom: Spacing.sm, alignItems: 'center',
  },
  offlineText: { ...Typography.bodySm, color: Colors.accentPurple },

  // Downloads
  storageCard: { marginBottom: Spacing.md },
  storageRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: Spacing.md,
  },
  storageTitle: { ...Typography.headingSm, color: Colors.textPrimary },
  storageMeta: { ...Typography.bodySm, color: Colors.textSecondary, marginTop: 2 },
  clearBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.xs,
    padding: Spacing.sm, borderRadius: Radius.sm,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  clearBtnText: { ...Typography.bodySm, color: Colors.textTertiary },

  // Scan Modal
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
  modalBtns: { flexDirection: 'row', gap: Spacing.md },
  cancelBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    height: 44, borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: Colors.glassBorder,
  },
  cancelBtnText: { ...Typography.headingSm, color: Colors.textSecondary },
  scanBtn: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    height: 44, borderRadius: Radius.full,
    backgroundColor: Colors.accentPrimary,
  },
  scanBtnText: { ...Typography.headingSm, color: Colors.bgPrimary },
});
