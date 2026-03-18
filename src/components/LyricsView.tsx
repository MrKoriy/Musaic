/**
 * LyricsView — Apple Music-style animated lyrics display.
 *
 * Features:
 * - Parses LRC format: [mm:ss.xx] Text
 * - Syncs to playback position (progress * duration)
 * - Active line: white, full-size, highlighted
 * - Past lines: dimmed, smaller
 * - Future lines: dimmed, smaller
 * - Auto-scrolls to keep active line centered
 * - Tap a line to seek to its timestamp
 * - Manual edit mode (shows editable TextInput per line)
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, TextInput, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Colors, Spacing, Typography } from '../theme';
import { getLyrics, generateLyrics, getLyricsJobStatus, saveLyrics } from '../services/apiService';
import type { LyricsResult, LyricsJobStatus } from '../services/apiService';

// ─── LRC Parser ──────────────────────────────────────────────────────────────

export interface LrcLine {
  timeSec: number;
  text: string;
}

export function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const raw of lrc.split('\n')) {
    const match = raw.match(/^\[(\d{1,2}):(\d{2})\.(\d{1,3})\]\s*(.*)/);
    if (!match) continue;
    const minutes = parseInt(match[1]!, 10);
    const seconds = parseInt(match[2]!, 10);
    const centiseconds = parseInt(match[3]!.padEnd(3, '0'), 10);
    const timeSec = minutes * 60 + seconds + centiseconds / 1000;
    const text = match[4]?.trim() ?? '';
    if (text) lines.push({ timeSec, text });
  }
  return lines.sort((a, b) => a.timeSec - b.timeSec);
}

// ─── Component ────────────────────────────────────────────────────────────────

type Props = {
  trackId: string;
  artist: string;
  title: string;
  duration: number;
  progress: number; // 0–1
  onSeek?: (progress: number) => void;
};

type LoadState = 'loading' | 'found' | 'not_found' | 'generating' | 'error';

export function LyricsView({ trackId, artist, title, duration, progress, onSeek }: Props) {
  const [lines, setLines] = useState<LrcLine[]>([]);
  const [rawLrc, setRawLrc] = useState('');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const lineRefs = useRef<Map<number, View>>(new Map());
  const scrollYRef = useRef<number[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentTimeSec = progress * duration;

  // Find active line index
  const activeIdx = lines.reduce((acc, line, i) => {
    return line.timeSec <= currentTimeSec ? i : acc;
  }, -1);

  // Load lyrics on mount
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');

    getLyrics(trackId, { artist, title, duration })
      .then((res: LyricsResult) => {
        if (cancelled) return;
        if (res.lrc) {
          const parsed = parseLrc(res.lrc);
          setLines(parsed);
          setRawLrc(res.lrc);
          setLoadState('found');
        } else {
          setLoadState('not_found');
        }
      })
      .catch(() => {
        if (!cancelled) setLoadState('error');
      });

    return () => { cancelled = true; };
  }, [trackId, artist, title, duration]);

  // Auto-scroll to active line
  useEffect(() => {
    if (activeIdx < 0 || !scrollRef.current || editMode) return;
    const y = scrollYRef.current[activeIdx];
    if (y != null) {
      scrollRef.current.scrollTo({ y: Math.max(0, y - 120), animated: true });
    }
  }, [activeIdx, editMode]);

  // Trigger AI generation
  const handleGenerate = useCallback(async () => {
    setLoadState('generating');
    try {
      await generateLyrics(trackId);
      // Poll for completion
      pollRef.current = setInterval(async () => {
        const status: LyricsJobStatus = await getLyricsJobStatus(trackId);
        if (status.status === 'done') {
          clearInterval(pollRef.current!);
          // Reload lyrics from cache
          const res = await getLyrics(trackId, { artist, title, duration });
          if (res.lrc) {
            setLines(parseLrc(res.lrc));
            setRawLrc(res.lrc);
            setLoadState('found');
          }
        } else if (status.status === 'failed') {
          clearInterval(pollRef.current!);
          setLoadState('error');
        }
      }, 5000);
    } catch {
      setLoadState('error');
    }
  }, [trackId, artist, title, duration]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // Save edited lyrics
  const handleSave = useCallback(async () => {
    try {
      await saveLyrics(trackId, editText);
      const parsed = parseLrc(editText);
      setLines(parsed);
      setRawLrc(editText);
      setEditMode(false);
      setLoadState('found');
    } catch {
      // Ignore save error
    }
  }, [trackId, editText]);

  // ── Render states ──

  if (loadState === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentPrimary} />
      </View>
    );
  }

  if (loadState === 'generating') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.accentPrimary} />
        <Text style={styles.statusText}>Transcribing lyrics with AI...</Text>
        <Text style={[styles.statusText, { fontSize: 12, marginTop: 4 }]}>
          ~3-5 min • Demucs + Parakeet TDT v3
        </Text>
      </View>
    );
  }

  if (loadState === 'not_found' || loadState === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.statusText}>
          {loadState === 'error' ? 'Failed to load lyrics' : 'No lyrics found'}
        </Text>
        <TouchableOpacity style={styles.actionBtn} onPress={handleGenerate}>
          <Text style={styles.actionBtnText}>Generate with AI</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: Colors.glassBorder }]}
          onPress={() => {
            setEditText('');
            setEditMode(true);
            setLoadState('found');
          }}
        >
          <Text style={[styles.actionBtnText, { color: Colors.textSecondary }]}>Add manually</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (editMode) {
    return (
      <KeyboardAvoidingView
        style={styles.editContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.editHeader}>
          <TouchableOpacity onPress={() => setEditMode(false)}>
            <Text style={{ color: Colors.textSecondary }}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.editTitle}>Edit Lyrics</Text>
          <TouchableOpacity onPress={handleSave}>
            <Text style={{ color: Colors.accentPrimary, fontWeight: '600' }}>Save</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.editHint}>LRC format: [mm:ss.xx] Lyric line</Text>
        <TextInput
          style={styles.editInput}
          value={editText}
          onChangeText={setEditText}
          multiline
          autoFocus
          placeholder="[00:12.00] First line..."
          placeholderTextColor={Colors.textTertiary}
          scrollEnabled
        />
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {lines.map((line, i) => {
          const isActive = i === activeIdx;
          const isPast = i < activeIdx;
          return (
            <TouchableOpacity
              key={i}
              activeOpacity={0.7}
              onPress={() => {
                if (onSeek && duration > 0) {
                  onSeek(line.timeSec / duration);
                }
              }}
              onLayout={(e) => {
                scrollYRef.current[i] = e.nativeEvent.layout.y;
              }}
            >
              <Text
                style={[
                  styles.lyricLine,
                  isActive && styles.lyricActive,
                  isPast && styles.lyricPast,
                  !isActive && !isPast && styles.lyricFuture,
                ]}
              >
                {line.text}
              </Text>
            </TouchableOpacity>
          );
        })}
        {/* Extra padding so last lines can be scrolled to center */}
        <View style={{ height: 200 }} />
      </ScrollView>

      {/* Edit button */}
      <TouchableOpacity
        style={styles.editFloatBtn}
        onPress={() => {
          setEditText(rawLrc);
          setEditMode(true);
        }}
      >
        <Text style={styles.editFloatBtnText}>Edit</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.lg,
    paddingHorizontal: Spacing.xl,
  },
  statusText: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
  },
  actionBtn: {
    backgroundColor: Colors.accentPrimary,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderRadius: 24,
  },
  actionBtnText: {
    ...Typography.body,
    color: '#fff',
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: Spacing.xl,
    paddingTop: 80,
  },
  lyricLine: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 32,
    color: Colors.textTertiary,
    marginBottom: Spacing.lg,
  },
  lyricActive: {
    color: Colors.textPrimary,
    fontSize: 26,
    lineHeight: 36,
  },
  lyricPast: {
    color: 'rgba(255,255,255,0.25)',
  },
  lyricFuture: {
    color: 'rgba(255,255,255,0.35)',
  },
  editFloatBtn: {
    position: 'absolute',
    bottom: Spacing.xl,
    right: Spacing.xl,
    backgroundColor: Colors.glassBgActive,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  editFloatBtnText: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
  },
  editContainer: {
    flex: 1,
  },
  editHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.glassBorder,
  },
  editTitle: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
  },
  editHint: {
    ...Typography.caption,
    color: Colors.textTertiary,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.sm,
  },
  editInput: {
    flex: 1,
    ...Typography.body,
    color: Colors.textPrimary,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    textAlignVertical: 'top',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 13,
    lineHeight: 20,
  },
});
