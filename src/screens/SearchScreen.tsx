import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, TextInput, ScrollView,
  SafeAreaView, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Search, Mic } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { TrackRow } from '../components/TrackRow';
import { usePlayerStore } from '../stores/usePlayerStore';
import { MOOD_TAGS, GENRE_COLORS } from '../data/mockData';
import { api, serverTrackToAppTrack } from '../services/apiService';
import { RootStackParamList, Track } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

export function SearchScreen() {
  const navigation = useNavigation<NavProp>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const { currentTrack, isPlaying, setQueue, addToQueue } = usePlayerStore();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const res = await api.searchTracks(q, 'local,soundcloud');
      setResults(res.tracks.map(serverTrackToAppTrack));
    } catch {
      setResults([]);
    }
    setLoading(false);
  }, []);

  function onChangeText(text: string) {
    setQuery(text);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(text), 300);
  }

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
        >
          <Text style={styles.heading}>Search</Text>

          {/* Search Bar */}
          <GlassCard style={styles.searchCard} borderRadius={Radius.full}>
            <View style={styles.searchRow}>
              <Search size={18} color={Colors.textTertiary} />
              <TextInput
                value={query}
                onChangeText={onChangeText}
                placeholder="Search songs, artists, albums"
                placeholderTextColor={Colors.textTertiary}
                style={styles.searchInput}
                returnKeyType="search"
                autoCorrect={false}
              />
              {loading ? (
                <ActivityIndicator size="small" color={Colors.textTertiary} />
              ) : query.length > 0 ? (
                <TouchableOpacity onPress={() => { setQuery(''); setResults([]); }}>
                  <Text style={styles.clearBtn}>✕</Text>
                </TouchableOpacity>
              ) : (
                <Mic size={18} color={Colors.textTertiary} />
              )}
            </View>
          </GlassCard>

          {/* Search Results */}
          {results.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>Results</Text>
              {results.map((track, i) => (
                <View key={track.id}>
                  {track.source === 'soundcloud' && i > 0 && results[i - 1].source !== 'soundcloud' && (
                    <Text style={styles.sourceLabel}>SoundCloud</Text>
                  )}
                  {track.source === 'soundcloud' && i === 0 && (
                    <Text style={styles.sourceLabel}>SoundCloud</Text>
                  )}
                  {track.source === 'local' && i === 0 && (
                    <Text style={styles.sourceLabel}>Local Library</Text>
                  )}
                  {track.source === 'local' && i > 0 && results[i - 1].source !== 'local' && (
                    <Text style={styles.sourceLabel}>Local Library</Text>
                  )}
                  <TrackRow
                    track={track}
                    index={i + 1}
                    isCurrent={currentTrack?.id === track.id}
                    isPlaying={isPlaying}
                    onPress={() => { setQueue(results, i); navigation.navigate('NowPlaying'); }}
                    onAddToQueue={(t) => addToQueue(t)}
                  />
                </View>
              ))}
            </>
          )}

          {/* Empty state after search */}
          {query.length > 1 && !loading && results.length === 0 && (
            <GlassCard style={{ padding: Spacing.xl, alignItems: 'center', marginTop: Spacing.lg }}>
              <Text style={{ ...Typography.body, color: Colors.textSecondary }}>
                No results for "{query}"
              </Text>
            </GlassCard>
          )}

          {/* Genre Grid (default) */}
          {query.length < 2 && (
            <>
              <Text style={styles.sectionTitle}>Browse by mood</Text>
              <View style={styles.genreGrid}>
                {MOOD_TAGS.map((tag) => {
                  const colors = GENRE_COLORS[tag] ?? ['#555', '#333'];
                  return (
                    <TouchableOpacity key={tag} style={styles.genreCardWrapper} activeOpacity={0.8}>
                      <LinearGradient
                        colors={[colors[0] + 'CC', colors[1] + '88']}
                        style={styles.genreCard}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                      >
                        <View style={styles.genreBorder} />
                        <View style={styles.genreCardInner}>
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
  searchCard: { marginBottom: Spacing.xl },
  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.lg, paddingVertical: Spacing.md - 2, gap: Spacing.sm,
  },
  searchInput: { flex: 1, ...Typography.body, color: Colors.textPrimary },
  clearBtn: { color: Colors.textTertiary, fontSize: 14 },
  sectionTitle: { ...Typography.headingSm, color: Colors.textPrimary, marginBottom: Spacing.md },
  sourceLabel: { ...Typography.caption, color: Colors.textTertiary, marginTop: Spacing.sm, marginBottom: Spacing.xs, letterSpacing: 0.5, textTransform: 'uppercase' },
  genreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  genreCardWrapper: { width: '47%', borderRadius: Radius.lg, overflow: 'hidden' },
  genreCard: { borderRadius: Radius.lg, overflow: 'hidden', position: 'relative' },
  genreBorder: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', borderRadius: Radius.lg, zIndex: 1,
  },
  genreCardInner: { height: 80, justifyContent: 'flex-end', padding: Spacing.md },
  genreText: { ...Typography.headingSm, color: Colors.textPrimary },
});
