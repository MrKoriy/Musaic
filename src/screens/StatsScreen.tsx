import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Image,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  BarChart2, Clock, Flame, Music, Mic2, Disc, TrendingUp,
} from 'lucide-react-native';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { api } from '../services/apiService';

// ─── Types ────────────────────────────────────────────────────────────────────

type Period = 'today' | 'week' | 'month' | 'alltime';

interface Overview {
  listens: { today: number; week: number; month: number; allTime: number };
  listeningTime: { todaySecs: number; weekSecs: number; monthSecs: number; allTimeSecs: number };
  streak: number;
  topTrack: { track_id: string; title: string; artist: string; play_count: number } | null;
  topArtist: { artist: string; play_count: number } | null;
}

interface TopTrack {
  track_id: string; title: string; artist: string; album: string | null;
  cover_url: string | null; duration: number; play_count: number;
}
interface TopArtist { artist: string; play_count: number; unique_tracks: number; cover_url: string | null }
interface TopAlbum { album: string; artist: string; play_count: number; cover_url: string | null }
interface HeatmapEntry { hour: number; play_count: number }
interface GenreEntry { genre: string; play_count: number; percentage: number }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatHour(h: number): string {
  if (h === 0) return '12am';
  if (h < 12) return `${h}am`;
  if (h === 12) return '12pm';
  return `${h - 12}pm`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color }: {
  label: string; value: string; icon: React.FC<any>; color: string;
}) {
  return (
    <GlassCard style={styles.statCard}>
      <View style={[styles.statIconWrap, { backgroundColor: color + '22' }]}>
        <Icon size={18} color={color} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </GlassCard>
  );
}

function SectionHeader({ title, icon: Icon }: { title: string; icon: React.FC<any> }) {
  return (
    <View style={styles.sectionHeader}>
      <Icon size={16} color={Colors.accentPrimary} />
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const PERIODS: { key: Period; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'week', label: 'Week' },
    { key: 'month', label: 'Month' },
    { key: 'alltime', label: 'All time' },
  ];
  return (
    <View style={styles.periodRow}>
      {PERIODS.map((p) => (
        <TouchableOpacity
          key={p.key}
          style={[styles.periodBtn, value === p.key && styles.periodBtnActive]}
          onPress={() => onChange(p.key)}
        >
          <Text style={[styles.periodBtnText, value === p.key && styles.periodBtnTextActive]}>
            {p.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function RankRow({ rank, title, subtitle, value, coverUrl, accent }: {
  rank: number; title: string; subtitle: string; value: string; coverUrl?: string | null; accent?: boolean;
}) {
  return (
    <View style={styles.rankRow}>
      <Text style={[styles.rankNum, accent && { color: Colors.accentPrimary }]}>{rank}</Text>
      {coverUrl ? (
        <Image source={{ uri: coverUrl }} style={styles.rankCover} />
      ) : (
        <View style={[styles.rankCover, { backgroundColor: Colors.bgTertiary, justifyContent: 'center', alignItems: 'center' }]}>
          <Music size={14} color={Colors.textTertiary} />
        </View>
      )}
      <View style={styles.rankInfo}>
        <Text style={styles.rankTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.rankSub} numberOfLines={1}>{subtitle}</Text>
      </View>
      <Text style={styles.rankValue}>{value}</Text>
    </View>
  );
}

function HeatmapRow({ heatmap }: { heatmap: HeatmapEntry[] }) {
  const { width: screenWidth } = useWindowDimensions();
  const max = Math.max(...heatmap.map((h) => h.play_count), 1);
  const cellCount = Math.max(heatmap.length, 24);
  const gap = 3;
  // Container width = screen - horizontal padding (Spacing.lg * 2) - card padding (Spacing.lg * 2)
  const containerWidth = screenWidth - Spacing.lg * 4;
  const cellSize = Math.floor((containerWidth - (cellCount - 1) * gap) / cellCount);
  return (
    <View>
      <View style={styles.heatmapGrid}>
        {heatmap.map((h) => {
          const intensity = h.play_count / max;
          const bg = intensity === 0
            ? Colors.bgTertiary
            : `rgba(233, 30, 140, ${0.15 + intensity * 0.85})`;
          return (
            <View
              key={h.hour}
              style={[styles.heatmapCell, { backgroundColor: bg, width: cellSize, height: cellSize }]}
            />
          );
        })}
      </View>
      <View style={styles.heatmapLabels}>
        {[0, 6, 12, 18].map((h) => (
          <Text key={h} style={styles.heatmapLabel}>{formatHour(h)}</Text>
        ))}
      </View>
    </View>
  );
}

function GenreBar({ genre, percentage, color }: { genre: string; percentage: number; color: string }) {
  return (
    <View style={styles.genreRow}>
      <Text style={styles.genreName} numberOfLines={1}>{genre}</Text>
      <View style={styles.genreBarTrack}>
        <View style={[styles.genreBarFill, { flex: Math.max(0.01, percentage), backgroundColor: color }]} />
        <View style={{ flex: Math.max(0.01, 100 - percentage) }} />
      </View>
      <Text style={styles.genrePct}>{percentage}%</Text>
    </View>
  );
}

// ─── Genre accent colors ──────────────────────────────────────────────────────

const GENRE_COLORS = [
  Colors.accentPrimary,
  Colors.accentPurple,
  Colors.accentGreen,
  '#f59e0b',
  '#06b6d4',
  '#f97316',
  '#ec4899',
  '#8b5cf6',
];

// ─── Main Screen ──────────────────────────────────────────────────────────────

export function StatsScreen() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<Period>('month');

  const [overview, setOverview] = useState<Overview | null>(null);
  const [topTracks, setTopTracks] = useState<TopTrack[]>([]);
  const [topArtists, setTopArtists] = useState<TopArtist[]>([]);
  const [topAlbums, setTopAlbums] = useState<TopAlbum[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapEntry[]>([]);
  const [genres, setGenres] = useState<GenreEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async (p: Period) => {
    try {
      const heatmapPeriod = p === 'today' ? 'week' : p === 'alltime' ? 'alltime' : p;
      const results = await Promise.allSettled([
        api.getStatsOverview(),
        api.getTopTracks(p, 10),
        api.getTopArtists(p),
        api.getTopAlbums(p),
        api.getListeningHeatmap(heatmapPeriod as 'week' | 'month' | 'alltime'),
        api.getGenreStats(p),
      ]);
      const val = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
        r.status === 'fulfilled' ? r.value : fallback;
      const emptyFallback = { tracks: [], artists: [], albums: [], heatmap: [], genres: [] };
      setOverview(val(results[0], null as Overview | null));
      setTopTracks(val(results[1], { tracks: [] as TopTrack[] }).tracks);
      setTopArtists(val(results[2], { artists: [] as TopArtist[] }).artists);
      setTopAlbums(val(results[3], { albums: [] as TopAlbum[] }).albums);
      setHeatmap(val(results[4], { heatmap: [] as HeatmapEntry[] }).heatmap);
      setGenres(val(results[5], { genres: [] as GenreEntry[] }).genres);
      const anyFailed = results.some((r) => r.status === 'rejected');
      setError(anyFailed ? 'Some stats could not be loaded' : null);
    } catch (e) {
      setError('Could not load stats. Is the server running?');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    loadAll(period).finally(() => setLoading(false));
  }, [period, loadAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll(period);
    setRefreshing(false);
  }, [period, loadAll]);

  const listensForPeriod = overview
    ? period === 'today' ? overview.listens.today
      : period === 'week' ? overview.listens.week
      : period === 'month' ? overview.listens.month
      : overview.listens.allTime
    : 0;

  const timeSecsForPeriod = overview
    ? period === 'today' ? overview.listeningTime.todaySecs
      : period === 'week' ? overview.listeningTime.weekSecs
      : period === 'month' ? overview.listeningTime.monthSecs
      : overview.listeningTime.allTimeSecs
    : 0;

  return (
    <SafeAreaView style={styles.safe}>
      <LinearGradient
        colors={['#0d0d14', '#1a0a1e', '#0d0d14']}
        style={StyleSheet.absoluteFill}
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.accentPrimary} />}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={styles.header}>
          <BarChart2 size={24} color={Colors.accentPrimary} />
          <Text style={styles.headerTitle}>Your Stats</Text>
        </View>

        {/* Period picker */}
        <PeriodPicker value={period} onChange={setPeriod} />

        {loading ? (
          <ActivityIndicator color={Colors.accentPrimary} style={{ marginTop: 48 }} />
        ) : error ? (
          <GlassCard style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </GlassCard>
        ) : (
          <>
            {/* Overview stat cards */}
            <View style={styles.statsGrid}>
              <StatCard
                label="Listens"
                value={String(listensForPeriod)}
                icon={TrendingUp}
                color={Colors.accentPrimary}
              />
              <StatCard
                label="Time"
                value={formatDuration(timeSecsForPeriod)}
                icon={Clock}
                color={Colors.accentPurple}
              />
              <StatCard
                label="Streak"
                value={`${overview?.streak ?? 0}d`}
                icon={Flame}
                color="#f59e0b"
              />
            </View>

            {/* Heatmap */}
            <GlassCard style={styles.section}>
              <SectionHeader title="Listening by hour" icon={Clock} />
              {heatmap.length > 0 ? (
                <HeatmapRow heatmap={heatmap} />
              ) : (
                <Text style={styles.emptyText}>No data yet</Text>
              )}
            </GlassCard>

            {/* Top Tracks */}
            <GlassCard style={styles.section}>
              <SectionHeader title="Top tracks" icon={Music} />
              {topTracks.length === 0 ? (
                <Text style={styles.emptyText}>No plays recorded yet</Text>
              ) : (
                topTracks.slice(0, 5).map((t, i) => (
                  <RankRow
                    key={t.track_id}
                    rank={i + 1}
                    title={t.title}
                    subtitle={t.artist}
                    value={`${t.play_count} play${t.play_count !== 1 ? 's' : ''}`}
                    coverUrl={t.cover_url}
                    accent={i === 0}
                  />
                ))
              )}
            </GlassCard>

            {/* Top Artists */}
            <GlassCard style={styles.section}>
              <SectionHeader title="Top artists" icon={Mic2} />
              {topArtists.length === 0 ? (
                <Text style={styles.emptyText}>No plays recorded yet</Text>
              ) : (
                topArtists.slice(0, 5).map((a, i) => (
                  <RankRow
                    key={a.artist}
                    rank={i + 1}
                    title={a.artist}
                    subtitle={`${a.unique_tracks} track${a.unique_tracks !== 1 ? 's' : ''}`}
                    value={`${a.play_count} play${a.play_count !== 1 ? 's' : ''}`}
                    coverUrl={a.cover_url}
                    accent={i === 0}
                  />
                ))
              )}
            </GlassCard>

            {/* Top Albums */}
            <GlassCard style={styles.section}>
              <SectionHeader title="Top albums" icon={Disc} />
              {topAlbums.length === 0 ? (
                <Text style={styles.emptyText}>No plays recorded yet</Text>
              ) : (
                topAlbums.slice(0, 5).map((a, i) => (
                  <RankRow
                    key={`${a.album}-${a.artist}`}
                    rank={i + 1}
                    title={a.album}
                    subtitle={a.artist}
                    value={`${a.play_count} play${a.play_count !== 1 ? 's' : ''}`}
                    coverUrl={a.cover_url}
                    accent={i === 0}
                  />
                ))
              )}
            </GlassCard>

            {/* Genre distribution */}
            {genres.length > 0 && (
              <GlassCard style={styles.section}>
                <SectionHeader title="Genres" icon={BarChart2} />
                {genres.map((g, i) => (
                  <GenreBar
                    key={g.genre}
                    genre={g.genre}
                    percentage={g.percentage}
                    color={GENRE_COLORS[i % GENRE_COLORS.length]}
                  />
                ))}
              </GlassCard>
            )}

            <View style={{ height: Spacing.xl }} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bgPrimary },
  scroll: { flex: 1 },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.lg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  headerTitle: {
    ...Typography.headingLg,
    color: Colors.textPrimary,
  },

  periodRow: {
    flexDirection: 'row',
    gap: Spacing.xs,
    marginBottom: Spacing.lg,
  },
  periodBtn: {
    flex: 1,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
    alignItems: 'center',
    backgroundColor: Colors.glassBg,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  periodBtnActive: {
    backgroundColor: Colors.accentPrimary + '22',
    borderColor: Colors.accentPrimary,
  },
  periodBtnText: {
    ...Typography.caption,
    color: Colors.textSecondary,
  },
  periodBtnTextActive: {
    color: Colors.accentPrimary,
    fontWeight: '600',
  },

  statsGrid: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    paddingHorizontal: Spacing.sm,
    gap: Spacing.xs,
    overflow: 'hidden',
  },
  statIconWrap: {
    width: 36,
    height: 36,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 26,
    color: Colors.textPrimary,
  },
  statLabel: {
    ...Typography.caption,
    color: Colors.textTertiary,
  },

  section: {
    marginBottom: Spacing.md,
    padding: Spacing.lg,
    gap: Spacing.sm,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: Spacing.xs,
  },
  sectionTitle: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
  },

  emptyText: {
    ...Typography.body,
    color: Colors.textTertiary,
    textAlign: 'center',
    paddingVertical: Spacing.md,
  },

  // Rank rows
  rankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xs,
  },
  rankNum: {
    width: 20,
    ...Typography.bodySm,
    color: Colors.textTertiary,
    textAlign: 'center',
  },
  rankCover: {
    width: 40,
    height: 40,
    borderRadius: Radius.sm,
  },
  rankInfo: {
    flex: 1,
  },
  rankTitle: {
    ...Typography.body,
    color: Colors.textPrimary,
  },
  rankSub: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
  },
  rankValue: {
    ...Typography.caption,
    color: Colors.textTertiary,
    flexShrink: 0,
  },

  // Heatmap
  heatmapGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 3,
    marginVertical: Spacing.sm,
  },
  heatmapCell: {
    borderRadius: 2,
  },
  heatmapLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  heatmapLabel: {
    ...Typography.caption,
    color: Colors.textTertiary,
  },

  // Genre bars
  genreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  genreName: {
    width: 80,
    flexShrink: 0,
    ...Typography.bodySm,
    color: Colors.textSecondary,
  },
  genreBarTrack: {
    flex: 1,
    height: 6,
    backgroundColor: Colors.bgTertiary,
    borderRadius: Radius.full,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  genreBarFill: {
    height: '100%',
    borderRadius: Radius.full,
  },
  genrePct: {
    width: 32,
    ...Typography.caption,
    color: Colors.textTertiary,
    textAlign: 'right',
  },

  errorCard: {
    padding: Spacing.xl,
    alignItems: 'center',
    marginTop: Spacing.xl,
  },
  errorText: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
});
