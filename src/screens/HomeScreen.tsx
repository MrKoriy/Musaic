import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Play, Pause, Music } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { TrackRow } from '../components/TrackRow';
import { usePlayerStore } from '../stores/usePlayerStore';
import { useLibraryStore } from '../stores/useLibraryStore';
import { api, serverTrackToAppTrack } from '../services/apiService';
import { MOOD_TAGS, GENRE_COLORS } from '../data/mockData';
import { RootStackParamList, Track } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

const CONTENT_TABS = ['Playlist', 'Artists', 'Albums', 'Streams', 'Favorites'];

export function HomeScreen() {
  const navigation = useNavigation<NavProp>();
  const [activeTag, setActiveTag] = useState(0);
  const [activeTab, setActiveTab] = useState(0);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const { currentTrack, isPlaying, setQueue, setIsPlaying } = usePlayerStore();
  const { isLiked, toggleLike } = useLibraryStore();

  const loadTracks = useCallback(async () => {
    try {
      const res = await api.getTracks({ source: 'local', limit: 30 });
      const mapped = res.tracks.map(serverTrackToAppTrack);
      setTracks(mapped);
    } catch {
      // Server may not be running; show empty state
      setTracks([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadTracks(); }, [loadTracks]);

  function playTrack(index: number) {
    if (tracks.length === 0) return;
    setQueue(tracks, index);
    navigation.navigate('NowPlaying');
  }

  function playAll() {
    if (tracks.length === 0) return;
    setQueue(tracks, 0);
    navigation.navigate('NowPlaying');
  }

  const totalDuration = tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const hrs = Math.floor(totalDuration / 3600);
  const mins = Math.floor((totalDuration % 3600) / 60);
  const heroMeta = tracks.length > 0
    ? `${tracks.length} songs · ${hrs > 0 ? hrs + ' hr ' : ''}${mins} min`
    : 'Scan a music folder in Library';

  return (
    <View style={styles.root}>
      {/* Ambient gradients */}
      <LinearGradient
        colors={['rgba(139, 92, 46, 0.30)', 'transparent']}
        style={styles.ambientWarm}
        start={{ x: 0, y: 1 }}
        end={{ x: 0.6, y: 0 }}
        pointerEvents="none"
      />
      <LinearGradient
        colors={['rgba(59, 46, 139, 0.15)', 'transparent']}
        style={styles.ambientCool}
        start={{ x: 1, y: 0 }}
        end={{ x: 0.4, y: 1 }}
        pointerEvents="none"
      />

      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.heading}>Good evening</Text>
              <Text style={styles.subHeading}>What do you want to listen to?</Text>
            </View>
            <GlassCard style={styles.avatar} borderRadius={Radius.full}>
              <View style={styles.avatarInner}>
                <Text style={styles.avatarText}>M</Text>
              </View>
            </GlassCard>
          </View>

          {/* Mood Tags */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.tagsRow}
            contentContainerStyle={styles.tagsContent}
          >
            {MOOD_TAGS.map((tag, i) => (
              <TouchableOpacity
                key={tag}
                onPress={() => setActiveTag(i)}
                style={[styles.tagChip, activeTag === i && styles.tagChipActive]}
              >
                <Text style={[styles.tagText, activeTag === i && styles.tagTextActive]}>
                  {tag}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Hero Card */}
          <TouchableOpacity
            activeOpacity={0.95}
            onPress={playAll}
            style={styles.heroWrapper}
          >
            <GlassCard style={styles.heroCard} borderRadius={Radius.xl} intensity={20}>
              <LinearGradient
                colors={['#1E3A5F', '#0d1b2e', '#0d0d14']}
                style={[StyleSheet.absoluteFill, { borderRadius: Radius.xl }]}
                start={{ x: 0.3, y: 0 }}
                end={{ x: 1, y: 1 }}
              />
              <LinearGradient
                colors={['transparent', 'rgba(0,0,0,0.85)']}
                style={[StyleSheet.absoluteFill, { borderRadius: Radius.xl }]}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
              />
              <View style={styles.heroContent}>
                <Text style={styles.heroMeta}>{heroMeta}</Text>
                <Text style={styles.heroLabel}>Your Library</Text>
                <Text style={styles.heroTitle}>Local Music</Text>
              </View>
              <View style={styles.heroPlay}>
                {isPlaying && tracks.some((t) => t.id === currentTrack?.id) ? (
                  <Pause size={22} color="#fff" fill="#fff" />
                ) : (
                  <Play size={22} color="#fff" fill="#fff" style={{ marginLeft: 2 }} />
                )}
              </View>
            </GlassCard>
          </TouchableOpacity>

          {/* Content Tabs */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.tabsRow}
            contentContainerStyle={styles.tabsContent}
          >
            {CONTENT_TABS.map((tab, i) => (
              <TouchableOpacity
                key={tab}
                onPress={() => setActiveTab(i)}
                style={[styles.tab, activeTab === i && styles.tabActive]}
              >
                <Text style={[styles.tabText, activeTab === i && styles.tabTextActive]}>
                  {tab}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Track List */}
          {loading ? (
            <ActivityIndicator color={Colors.accentPrimary} style={{ marginTop: Spacing.xl }} />
          ) : tracks.length === 0 ? (
            <GlassCard style={styles.emptyState}>
              <Music size={32} color={Colors.textTertiary} />
              <Text style={styles.emptyTitle}>No tracks yet</Text>
              <Text style={styles.emptyText}>Go to Library and scan a music folder</Text>
            </GlassCard>
          ) : (
            <View style={styles.trackList}>
              {tracks.map((track, i) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={i + 1}
                  isCurrent={currentTrack?.id === track.id}
                  isPlaying={isPlaying}
                  isLiked={isLiked(track.id)}
                  onPress={() => playTrack(i)}
                  onLike={() => toggleLike(track.id)}
                />
              ))}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
  },
  ambientWarm: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: '70%',
    height: '60%',
  },
  ambientCool: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: '60%',
    height: '50%',
  },
  safeArea: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing['3xl'],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  heading: {
    ...Typography.headingXl,
    color: Colors.textPrimary,
  },
  subHeading: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  avatar: {},
  avatarInner: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    ...Typography.headingSm,
    color: Colors.accentPrimary,
  },
  tagsRow: {
    marginBottom: Spacing.xl,
  },
  tagsContent: {
    paddingRight: Spacing.lg,
    gap: Spacing.sm,
  },
  tagChip: {
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.xs + 2,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    backgroundColor: Colors.glassBg,
  },
  tagChipActive: {
    backgroundColor: 'rgba(233, 30, 140, 0.15)',
    borderColor: 'rgba(233, 30, 140, 0.40)',
  },
  tagText: {
    ...Typography.caption,
    color: Colors.textSecondary,
  },
  tagTextActive: {
    color: Colors.accentPrimary,
  },
  heroWrapper: {
    marginBottom: Spacing.xl,
  },
  heroCard: {
    height: 220,
    overflow: 'hidden',
    position: 'relative',
  },
  heroContent: {
    position: 'absolute',
    bottom: 40,
    left: Spacing.lg,
    right: 80,
  },
  heroMeta: {
    ...Typography.caption,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  heroLabel: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
    marginBottom: 2,
  },
  heroTitle: {
    ...Typography.headingXl,
    color: Colors.textPrimary,
  },
  heroPlay: {
    position: 'absolute',
    right: Spacing.lg,
    bottom: 36,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsRow: {
    marginBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  tabsContent: {
    paddingRight: Spacing.lg,
    gap: Spacing.xl,
  },
  tab: {
    paddingBottom: Spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: Colors.accentPrimary,
  },
  tabText: {
    ...Typography.body,
    color: Colors.textSecondary,
  },
  tabTextActive: {
    color: Colors.textPrimary,
    fontWeight: '600',
  },
  trackList: {},
  emptyState: {
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.xl,
  },
  emptyTitle: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
    marginTop: Spacing.sm,
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
});
