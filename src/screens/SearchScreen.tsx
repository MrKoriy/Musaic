import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, ScrollView,
  SafeAreaView, TouchableOpacity, ActivityIndicator,
  NativeSyntheticEvent, NativeScrollEvent,
} from 'react-native';
import { Search, Clock, X, Zap, Smile, CloudMoon, Dumbbell, CloudRain, PartyPopper, Target, Heart, Moon } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { MMKV } from 'react-native-mmkv';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { TrackRow } from '../components/TrackRow';
import { usePlayerStore } from '../stores/usePlayerStore';
import { MOOD_TAGS, GENRE_COLORS } from '../data/mockData';
import { api, serverTrackToAppTrack } from '../services/apiService';
import { RootStackParamList, Track } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList>;
type SourceFilter = 'all' | 'local' | 'soundcloud' | 'vk';

const SOURCE_FILTERS: { id: SourceFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'soundcloud', label: 'SoundCloud' },
  { id: 'vk', label: 'VK' },
];

const MOOD_ICONS: Record<string, React.FC<{ size: number; color: string }>> = {
  'Energise': Zap,
  'Feel good': Smile,
  'Relax': CloudMoon,
  'Workout': Dumbbell,
  'Sad': CloudRain,
  'Party': PartyPopper,
  'Focus': Target,
  'Romance': Heart,
  'Sleep': Moon,
};

const storage = new MMKV({ id: 'musaic-search' });
const RECENT_KEY = 'recent_searches';
const MAX_RECENT = 8;

function loadRecentSearches(): string[] {
  try {
    const raw = storage.getString(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(query: string) {
  const trimmed = query.trim();
  if (!trimmed) return;
  const current = loadRecentSearches();
  const filtered = current.filter((q) => q !== trimmed);
  const updated = [trimmed, ...filtered].slice(0, MAX_RECENT);
  storage.set(RECENT_KEY, JSON.stringify(updated));
}

function removeRecentSearch(query: string) {
  const current = loadRecentSearches();
  storage.set(RECENT_KEY, JSON.stringify(current.filter((q) => q !== query)));
}

export function SearchScreen() {
  const navigation = useNavigation<NavProp>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [inputFocused, setInputFocused] = useState(false);
  const [searchOffset, setSearchOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const { currentTrack, isPlaying, setQueue, addToQueue } = usePlayerStore();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    setRecentSearches(loadRecentSearches());
    return () => { searchAbort.current?.abort(); };
  }, []);

  const doSearch = useCallback(async (q: string, source: SourceFilter) => {
    if (q.length < 2) { setResults([]); setHasMore(false); return; }
    // Cancel any in-flight search to prevent stale results overwriting newer ones
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setLoading(true);
    setSearchOffset(0);
    const sources = source === 'all' ? 'local,soundcloud,vk' : source;
    try {
      const res = await api.searchTracks(q, sources, 30, 0);
      if (controller.signal.aborted) return;
      const mapped = res.tracks.map(serverTrackToAppTrack);
      setResults(mapped);
      setHasMore(mapped.length >= 20);
      setSearchOffset(30);
    } catch {
      if (controller.signal.aborted) return;
      setResults([]);
      setHasMore(false);
    }
    if (!controller.signal.aborted) setLoading(false);
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || query.length < 2) return;
    setLoadingMore(true);
    const sources = sourceFilter === 'all' ? 'local,soundcloud,vk' : sourceFilter;
    try {
      const res = await api.searchTracks(query, sources, 30, searchOffset);
      const mapped = res.tracks.map(serverTrackToAppTrack);
      if (mapped.length === 0) {
        setHasMore(false);
      } else {
        setResults((prev) => [...prev, ...mapped]);
        setSearchOffset((prev) => prev + 30);
        setHasMore(mapped.length >= 20);
      }
    } catch {
      setHasMore(false);
    }
    setLoadingMore(false);
  }, [loadingMore, hasMore, query, sourceFilter, searchOffset]);

  function onChangeText(text: string) {
    setQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(text, sourceFilter), 300);
  }

  function onSelectSource(src: SourceFilter) {
    setSourceFilter(src);
    if (query.length >= 2) {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      doSearch(query, src);
    }
  }

  function onClear() {
    setQuery('');
    setResults([]);
  }

  function onSubmitEditing() {
    if (query.trim().length >= 2) {
      saveRecentSearch(query.trim());
      setRecentSearches(loadRecentSearches());
    }
  }

  function onSelectRecent(q: string) {
    setQuery(q);
    doSearch(q, sourceFilter);
  }

  function onRemoveRecent(q: string) {
    removeRecentSearch(q);
    setRecentSearches(loadRecentSearches());
  }

  // Group results by source
  const groupedResults: { source: string; tracks: Track[] }[] = [];
  for (const track of results) {
    const last = groupedResults[groupedResults.length - 1];
    if (last && last.source === track.source) {
      last.tracks.push(track);
    } else {
      groupedResults.push({ source: track.source, tracks: [track] });
    }
  }

  const sourceLabel: Record<string, string> = {
    local: 'Local Library',
    soundcloud: 'SoundCloud',
    vk: 'VK Music',
  };

  const showSuggestions = inputFocused && query.length < 2 && recentSearches.length > 0;

  return (
    <View style={styles.root}>
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
          keyboardShouldPersistTaps="handled"
          onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
            const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
            const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
            if (distanceFromBottom < 200 && hasMore && !loadingMore) {
              loadMore();
            }
          }}
          scrollEventThrottle={400}
        >
          <Text style={styles.heading}>Search</Text>

          {/* Search Bar */}
          <GlassCard style={styles.searchCard} borderRadius={Radius.full}>
            <View style={styles.searchRow}>
              <Search size={18} color={Colors.textTertiary} />
              <TextInput
                value={query}
                onChangeText={onChangeText}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                onSubmitEditing={onSubmitEditing}
                placeholder="Search songs, artists, albums"
                placeholderTextColor={Colors.textTertiary}
                style={styles.searchInput}
                returnKeyType="search"
                autoCorrect={false}
              />
              {loading ? (
                <ActivityIndicator size="small" color={Colors.textTertiary} />
              ) : query.length > 0 ? (
                <TouchableOpacity onPress={onClear}>
                  <Text style={styles.clearBtn}>✕</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </GlassCard>

          {/* Source Filter Chips */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
            style={styles.filterScroll}
          >
            {SOURCE_FILTERS.map((f) => (
              <TouchableOpacity
                key={f.id}
                style={[styles.filterChip, sourceFilter === f.id && styles.filterChipActive]}
                onPress={() => onSelectSource(f.id)}
                activeOpacity={0.75}
              >
                <Text style={[styles.filterChipText, sourceFilter === f.id && styles.filterChipTextActive]}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Recent Searches / Suggestions */}
          {showSuggestions && (
            <View style={styles.recentSection}>
              <Text style={styles.sectionTitle}>Recent</Text>
              {recentSearches.map((q) => (
                <TouchableOpacity
                  key={q}
                  style={styles.recentRow}
                  onPress={() => onSelectRecent(q)}
                  activeOpacity={0.7}
                >
                  <Clock size={14} color={Colors.textTertiary} />
                  <Text style={styles.recentText} numberOfLines={1}>{q}</Text>
                  <TouchableOpacity onPress={() => onRemoveRecent(q)} hitSlop={8}>
                    <X size={14} color={Colors.textTertiary} />
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Search Results grouped by source */}
          {results.length > 0 && (
            <>
              {groupedResults.map((group) => (
                <View key={group.source}>
                  <Text style={styles.sourceLabel}>{sourceLabel[group.source] ?? group.source}</Text>
                  {group.tracks.map((track, i) => {
                    const globalIndex = results.indexOf(track);
                    return (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={i + 1}
                        isCurrent={currentTrack?.id === track.id}
                        isPlaying={isPlaying}
                        onPress={() => {
                          saveRecentSearch(query.trim());
                          setRecentSearches(loadRecentSearches());
                          setQueue(results, globalIndex);
                          navigation.navigate('NowPlaying');
                        }}
                        onAddToQueue={(t) => addToQueue(t)}
                      />
                    );
                  })}
                </View>
              ))}

              {/* Loading more indicator */}
              {loadingMore && (
                <ActivityIndicator color={Colors.accentPrimary} style={{ marginVertical: Spacing.md }} />
              )}
            </>
          )}

          {/* Empty state after search */}
          {query.length > 1 && !loading && results.length === 0 && (
            <GlassCard style={styles.emptyCard}>
              <Text style={styles.emptyText}>No results for "{query}"</Text>
            </GlassCard>
          )}

          {/* Genre Grid (default) */}
          {query.length < 2 && (
            <>
              <Text style={styles.sectionTitle}>Browse by mood</Text>
              <View style={styles.genreGrid}>
                {MOOD_TAGS.map((tag) => {
                  const colors = GENRE_COLORS[tag] ?? ['#555', '#333'];
                  const IconComponent = MOOD_ICONS[tag];
                  return (
                    <TouchableOpacity
                      key={tag}
                      style={styles.genreCardWrapper}
                      activeOpacity={0.8}
                      onPress={() => {
                        setQuery(tag);
                        doSearch(tag, sourceFilter);
                      }}
                    >
                      <LinearGradient
                        colors={[colors[0] + 'CC', colors[1] + '88']}
                        style={styles.genreCard}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                      >
                        <View style={styles.genreBorder} />
                        <View style={styles.genreCardInner}>
                          {IconComponent && (
                            <IconComponent size={28} color="rgba(255,255,255,0.85)" />
                          )}
                          <Text style={styles.genreText}>{tag}</Text>
                        </View>
                      </LinearGradient>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
  ambientCool: { position: 'absolute', top: 0, right: 0, width: '60%', height: '50%' },
  safeArea: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing['3xl'] },
  heading: { ...Typography.headingXl, color: Colors.textPrimary, marginTop: Spacing.lg, marginBottom: Spacing.lg },
  searchCard: { marginBottom: Spacing.md },
  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, height: 40, gap: Spacing.sm,
  },
  searchInput: { flex: 1, ...Typography.body, color: Colors.textPrimary, padding: 0 },
  clearBtn: { color: Colors.textTertiary, fontSize: 14 },
  filterScroll: { marginBottom: Spacing.lg },
  filterRow: { flexDirection: 'row', gap: Spacing.sm, paddingVertical: Spacing.xs },
  filterChip: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  filterChipActive: {
    backgroundColor: Colors.accentPrimary,
    borderColor: Colors.accentPrimary,
  },
  filterChipText: { ...Typography.bodySm, color: Colors.textSecondary },
  filterChipTextActive: { color: Colors.textPrimary, fontWeight: '600' },
  recentSection: { marginBottom: Spacing.lg },
  recentRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.glassBorder,
  },
  recentText: { flex: 1, ...Typography.body, color: Colors.textSecondary },
  sectionTitle: { ...Typography.headingSm, color: Colors.textPrimary, marginBottom: Spacing.md },
  sourceLabel: {
    ...Typography.caption, color: Colors.textTertiary,
    marginTop: Spacing.sm, marginBottom: Spacing.xs,
    letterSpacing: 0.5, textTransform: 'uppercase',
  },
  emptyCard: { padding: Spacing.xl, alignItems: 'center', marginTop: Spacing.lg },
  emptyText: { ...Typography.body, color: Colors.textSecondary },
  loadMoreBtn: {
    alignItems: 'center',
    paddingVertical: Spacing.md,
    marginTop: Spacing.sm,
    marginBottom: Spacing.md,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  loadMoreText: {
    ...Typography.button,
    color: Colors.accentPrimary,
  },
  genreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  genreCardWrapper: { width: '47%', borderRadius: Radius.lg, overflow: 'hidden' },
  genreCard: { borderRadius: Radius.lg, overflow: 'hidden', position: 'relative' },
  genreBorder: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderRadius: Radius.lg, zIndex: 1,
  },
  genreCardInner: { height: 100, justifyContent: 'flex-end', padding: Spacing.md, gap: Spacing.xs },
  genreText: { ...Typography.headingSm, color: Colors.textPrimary },
});
