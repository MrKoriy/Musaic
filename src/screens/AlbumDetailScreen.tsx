import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  SafeAreaView, ActivityIndicator, Image,
} from 'react-native';
import { ChevronDown, Play, Shuffle } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Colors, Spacing, Typography, Radius, Shadows } from '../theme';
import { TrackRow } from '../components/TrackRow';
import { usePlayerStore } from '../stores/usePlayerStore';
import { api, serverTrackToAppTrack } from '../services/apiService';
import { RootStackParamList, Track, Album } from '../types';
import { formatDuration } from '../data/mockData';

type NavProp = NativeStackNavigationProp<RootStackParamList>;
type RouteP = RouteProp<RootStackParamList, 'AlbumDetail'>;

export function AlbumDetailScreen() {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RouteP>();
  const { album } = route.params;
  const { currentTrack, isPlaying, setQueue } = usePlayerStore();

  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getAlbumTracks(album.album, album.artist)
      .then((res) => setTracks(res.tracks.map(serverTrackToAppTrack)))
      .catch((e) => console.warn('album tracks error', e))
      .finally(() => setLoading(false));
  }, [album]);

  const totalDuration = tracks.reduce((s, t) => s + (t.duration ?? 0), 0);

  async function playAll(shuffled = false) {
    const list = shuffled ? [...tracks].sort(() => Math.random() - 0.5) : tracks;
    await setQueue(list, 0);
    navigation.navigate('NowPlaying');
  }

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['rgba(139,92,46,0.25)', 'transparent']}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
      />
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* Back button */}
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <ChevronDown size={28} color={Colors.textSecondary} />
          </TouchableOpacity>

          {/* Album art */}
          <View style={styles.artContainer}>
            {album.cover_url ? (
              <Image source={{ uri: album.cover_url }} style={styles.art} />
            ) : (
              <View style={[styles.art, styles.artPlaceholder]}>
                <Text style={styles.artNote}>♪</Text>
              </View>
            )}
          </View>

          {/* Album info */}
          <Text style={styles.albumTitle} numberOfLines={2}>{album.album}</Text>
          <Text style={styles.albumArtist}>{album.artist}</Text>
          <Text style={styles.albumMeta}>
            {album.track_count} tracks · {formatDuration(totalDuration)}
          </Text>

          {/* Play buttons */}
          <View style={styles.ctrlRow}>
            <TouchableOpacity style={styles.playBtn} onPress={() => playAll(false)}>
              <Play size={18} color={Colors.bgPrimary} fill={Colors.bgPrimary} />
              <Text style={styles.playBtnText}>Play</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.shuffleBtn} onPress={() => playAll(true)}>
              <Shuffle size={18} color={Colors.textPrimary} />
              <Text style={styles.shuffleBtnText}>Shuffle</Text>
            </TouchableOpacity>
          </View>

          {/* Track list */}
          {loading ? (
            <ActivityIndicator color={Colors.accentPrimary} style={{ marginTop: Spacing.xl }} />
          ) : (
            tracks.map((track, i) => (
              <TrackRow
                key={track.id}
                track={track}
                index={i + 1}
                isCurrent={currentTrack?.id === track.id}
                isPlaying={isPlaying}
                onPress={() => { setQueue(tracks, i); navigation.navigate('NowPlaying'); }}
              />
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const ART = 220;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
  scroll: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing['3xl'] },
  backBtn: {
    marginTop: Spacing.md,
    marginBottom: Spacing.lg,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artContainer: { alignItems: 'center', marginBottom: Spacing.xl },
  art: {
    width: ART,
    height: ART,
    borderRadius: Radius.xl,
  },
  artPlaceholder: {
    backgroundColor: Colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artNote: { fontSize: 64, color: 'rgba(255,255,255,0.2)' },
  albumTitle: {
    ...Typography.headingXl,
    color: Colors.textPrimary,
    textAlign: 'center',
    marginBottom: Spacing.xs,
  },
  albumArtist: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
    marginBottom: Spacing.xs,
  },
  albumMeta: {
    ...Typography.caption,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginBottom: Spacing.xl,
  },
  ctrlRow: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginBottom: Spacing.xl,
  },
  playBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    height: 46,
    borderRadius: Radius.full,
    backgroundColor: Colors.accentPrimary,
  },
  playBtnText: {
    ...Typography.headingSm,
    color: Colors.bgPrimary,
  },
  shuffleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    height: 46,
    borderRadius: Radius.full,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  shuffleBtnText: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
  },
});
