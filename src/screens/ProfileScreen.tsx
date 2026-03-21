import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  TouchableOpacity,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Switch,
  ActivityIndicator,
} from 'react-native';
import {
  User, Server, Check, X, Wifi, Radio, HardDrive, Trash2,
  Music2, Settings, ChevronRight, Bug, BarChart2,
  Key, Volume2, Sliders, LogIn, LogOut, List, Download, Globe,
} from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { EqualizerSheet } from '../components/EqualizerSheet';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { SERVER_URL, setServerUrl, clearServerUrl, getStoredServerUrl, api } from '../services/apiService';
import { loginWithVKOAuth } from '../hooks/useVKAuth';
import { useSettingsStore, StreamQuality } from '../stores/useSettingsStore';
import * as FileSystem from 'expo-file-system/legacy';

// ── Helpers ──────────────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return <Text style={styles.sectionLabel}>{label}</Text>;
}

function RowItem({
  icon: Icon,
  label,
  value,
  onPress,
  danger,
  right,
  iconColor,
}: {
  icon: React.FC<{ size: number; color: string }>;
  label: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  right?: React.ReactNode;
  iconColor?: string;
}) {
  const content = (
    <GlassCard style={styles.rowCard}>
      <View style={styles.rowInner}>
        <Icon size={18} color={iconColor ?? (danger ? Colors.accentPrimary : Colors.textSecondary)} />
        <Text style={[styles.rowLabel, danger && styles.dangerText]}>{label}</Text>
        <View style={styles.rowRight}>
          {value ? <Text style={styles.rowValue}>{value}</Text> : null}
          {right ?? (onPress ? <ChevronRight size={14} color={Colors.textTertiary} /> : null)}
        </View>
      </View>
    </GlassCard>
  );

  return onPress ? (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}>{content}</TouchableOpacity>
  ) : content;
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ProfileScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [showEqualizer, setShowEqualizer] = useState(false);
  const [serverDraft, setServerDraft] = useState('');
  const [editingServer, setEditingServer] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionOk, setConnectionOk] = useState<boolean | null>(null);

  // VK auth local UI state (vkAuthenticated/vkLoggedInUser live in the store)
  const [vkUsername, setVkUsername] = useState('');
  const [vkPassword, setVkPassword] = useState('');
  const [showVkLogin, setShowVkLogin] = useState(false);
  const [vkLoggingIn, setVkLoggingIn] = useState(false);
  const [vkPlaylists, setVkPlaylists] = useState<Array<{ id: number; owner_id: number; title: string; count: number }>>([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [importingPlaylist, setImportingPlaylist] = useState<number | null>(null);

  const [cacheSize, setCacheSize] = useState<string | null>(null);

  const {
    sources, toggleSource,
    vkAuthenticated, vkLoggedInUser, setVkAuth, clearVkAuth,
    streamQuality, setStreamQuality,
    crossfadeSec, setCrossfadeSec,
    gapless, setGapless,
    normalization, setNormalization,
    resetOnboarding,
  } = useSettingsStore();

  const currentUrl = SERVER_URL;
  const isCustom = !!getStoredServerUrl();

  // ── Server ────────────────────────────────────────────────────────────────

  const startEditingServer = useCallback(() => {
    setServerDraft(getStoredServerUrl() ?? '');
    setConnectionOk(null);
    setEditingServer(true);
  }, []);

  const saveServer = useCallback(() => {
    const trimmed = serverDraft.trim();
    if (!trimmed) { Alert.alert('Invalid URL', 'Please enter a valid IP or URL.'); return; }
    let url = trimmed;
    if (!url.startsWith('http')) url = `http://${url}`;
    if (!/:\d+$/.test(url.replace(/^https?:\/\//, ''))) url = `${url}:3001`;
    setServerUrl(url);
    setEditingServer(false);
    setConnectionOk(null);
    Alert.alert('Saved', `Server: ${url}`);
  }, [serverDraft]);

  const testConnection = useCallback(async () => {
    setTestingConnection(true);
    setConnectionOk(null);
    try {
      const ok = await api.ping();
      setConnectionOk(ok);
    } catch {
      setConnectionOk(false);
    } finally {
      setTestingConnection(false);
    }
  }, []);

  const resetServer = useCallback(() => {
    Alert.alert('Reset Server URL', 'Reset to auto-detection?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset', style: 'destructive',
        onPress: () => { clearServerUrl(); setEditingServer(false); setConnectionOk(null); },
      },
    ]);
  }, []);

  // ── VK Auth ───────────────────────────────────────────────────────────────

  const checkVkStatus = useCallback(async () => {
    try {
      const res = await api.vkMe();
      setVkAuth(res.authenticated, res.username);
    } catch {
      setVkAuth(false, null);
    }
  }, [setVkAuth]);

  useEffect(() => {
    checkVkStatus();
  }, [checkVkStatus]);

  const doVkOAuthLogin = useCallback(async () => {
    setVkLoggingIn(true);
    try {
      await loginWithVKOAuth();
      const status = await api.vkMe();
      setVkAuth(status.authenticated, status.username);
      if (status.authenticated) {
        Alert.alert('Connected', 'VK account connected.');
      }
    } catch (e: any) {
      if (e.message !== 'VK login was cancelled') {
        Alert.alert('Error', e.message ?? String(e));
      }
    } finally {
      setVkLoggingIn(false);
    }
  }, [setVkAuth]);

  const doVkLogin = useCallback(async () => {
    if (!vkUsername.trim() || !vkPassword.trim()) {
      Alert.alert('Missing fields', 'Enter your VK username and password.');
      return;
    }
    setVkLoggingIn(true);
    try {
      await api.vkLogin(vkUsername.trim(), vkPassword.trim());
      setVkAuth(true, vkUsername.trim());
      setShowVkLogin(false);
      setVkPassword('');
      Alert.alert('Connected', 'VK account connected.');
    } catch (e: any) {
      if (e && typeof e === 'object' && 'requires2FA' in e && e.requires2FA) {
        const urlMatch = (e.message ?? '').match(/Open: (https?:\/\/\S+)/);
        Alert.alert(
          '2FA Required',
          urlMatch
            ? `VK requires approval in the VK app (or open the link below), then try again.\n\n${urlMatch[1]}`
            : 'VK requires 2-factor authentication. Approve the login in the VK app, then try again.',
        );
      } else {
        Alert.alert('Login failed', e.message ?? String(e));
      }
    } finally {
      setVkLoggingIn(false);
    }
  }, [vkUsername, vkPassword, setVkAuth]);

  const doVkLogout = useCallback(() => {
    Alert.alert('Disconnect VK', 'Remove VK account?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect', style: 'destructive',
        onPress: async () => {
          try { await api.vkLogout(); } catch {}
          clearVkAuth();
          setVkPlaylists([]);
        },
      },
    ]);
  }, [clearVkAuth]);

  const loadVkPlaylists = useCallback(async () => {
    setLoadingPlaylists(true);
    try {
      const res = await api.vkPlaylists();
      setVkPlaylists(res.playlists.map(p => ({ id: p.id, owner_id: p.owner_id, title: p.title, count: p.count })));
    } catch (e: any) {
      Alert.alert('Error', 'Could not load VK playlists: ' + (e.message ?? String(e)));
    } finally {
      setLoadingPlaylists(false);
    }
  }, []);

  const importVkPlaylist = useCallback(async (playlistId: number, ownerId: number, title: string) => {
    setImportingPlaylist(playlistId);
    try {
      await api.vkPlaylistTracks(playlistId, ownerId);
      Alert.alert('Imported', `"${title}" tracks cached locally.`);
    } catch (e: any) {
      Alert.alert('Error', 'Import failed: ' + (e.message ?? String(e)));
    } finally {
      setImportingPlaylist(null);
    }
  }, []);

  // ── Storage ───────────────────────────────────────────────────────────────

  const loadCacheSize = useCallback(async () => {
    try {
      const info = await FileSystem.getInfoAsync(FileSystem.cacheDirectory ?? '');
      if (info.exists && 'size' in info) {
        const mb = ((info.size as number) / 1024 / 1024).toFixed(1);
        setCacheSize(`${mb} MB`);
      } else {
        setCacheSize('Unknown');
      }
    } catch {
      setCacheSize('Unknown');
    }
  }, []);

  const clearCache = useCallback(() => {
    Alert.alert('Clear Cache', 'Delete all cached files?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear', style: 'destructive',
        onPress: async () => {
          try {
            const dir = FileSystem.cacheDirectory;
            if (dir) {
              const items = await FileSystem.readDirectoryAsync(dir);
              await Promise.all(
                items.map((name: string) =>
                  FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(() => {}),
                ),
              );
            }
            setCacheSize('0 MB');
            Alert.alert('Done', 'Cache cleared.');
          } catch {
            Alert.alert('Error', 'Could not clear cache.');
          }
        },
      },
    ]);
  }, []);

  // ── Crossfade ─────────────────────────────────────────────────────────────

  const cycleCrossfade = useCallback(() => {
    const opts = [0, 2, 5, 10];
    const cur = opts.indexOf(crossfadeSec);
    setCrossfadeSec(opts[(cur + 1) % opts.length]);
  }, [crossfadeSec, setCrossfadeSec]);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.heading}>Settings</Text>

          {/* ── Music Sources ── */}
          <SectionLabel label="Music Sources" />

          <GlassCard style={styles.toggleCard}>
            {(['local', 'vk', 'soundcloud'] as const).map((src, i: number, arr) => (
              <View key={src} style={[styles.toggleRow, i < arr.length - 1 && styles.toggleDivider]}>
                <Radio size={16} color={Colors.textSecondary} />
                <Text style={styles.toggleLabel}>
                  {src === 'local' ? 'Local Library' : src === 'vk' ? 'VK Music' : 'SoundCloud'}
                </Text>
                <Switch
                  value={sources[src]}
                  onValueChange={() => toggleSource(src)}
                  trackColor={{ false: 'rgba(255,255,255,0.1)', true: Colors.accentPrimary + '66' }}
                  thumbColor={sources[src] ? Colors.accentPrimary : Colors.textTertiary}
                />
              </View>
            ))}
          </GlassCard>

          {/* ── VK Auth ── */}
          {sources.vk && (
            <>
              <SectionLabel label="VK Music" />
              <GlassCard style={styles.serverCard}>
                <View style={styles.serverHeader}>
                  <Key size={18} color={Colors.accentPurple} />
                  <Text style={styles.serverTitle}>VK Account</Text>
                  {vkAuthenticated && (
                    <View style={[styles.customBadge, { borderColor: Colors.accentGreen + '55', backgroundColor: Colors.accentGreen + '22' }]}>
                      <Text style={[styles.customBadgeText, { color: Colors.accentGreen }]}>Connected</Text>
                    </View>
                  )}
                </View>

                {vkAuthenticated ? (
                  <>
                    <View style={styles.urlRow}>
                      <User size={14} color={Colors.textTertiary} />
                      <Text style={styles.urlText} numberOfLines={1}>{vkLoggedInUser ?? 'VK User'}</Text>
                    </View>
                    <TouchableOpacity onPress={doVkLogout} style={[styles.testBtn, { marginTop: Spacing.xs }]}>
                      <LogOut size={14} color={Colors.accentPrimary} />
                      <Text style={[styles.testBtnText, { color: Colors.accentPrimary }]}>Disconnect</Text>
                    </TouchableOpacity>
                  </>
                ) : showVkLogin ? (
                  <>
                    <TextInput
                      style={styles.input}
                      value={vkUsername}
                      onChangeText={setVkUsername}
                      placeholder="VK username or phone"
                      placeholderTextColor={Colors.textTertiary}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                    />
                    <TextInput
                      style={[styles.input, { marginTop: Spacing.xs }]}
                      value={vkPassword}
                      onChangeText={setVkPassword}
                      placeholder="Password"
                      placeholderTextColor={Colors.textTertiary}
                      secureTextEntry
                      returnKeyType="done"
                      onSubmitEditing={doVkLogin}
                    />
                    <View style={[styles.inputRow, { marginTop: Spacing.xs }]}>
                      <TouchableOpacity
                        onPress={doVkLogin}
                        style={[styles.iconBtn, { flex: 1, paddingHorizontal: Spacing.md }]}
                        disabled={vkLoggingIn}
                      >
                        {vkLoggingIn
                          ? <ActivityIndicator size="small" color={Colors.accentPrimary} />
                          : <Text style={{ ...Typography.button, color: Colors.accentPrimary }}>Login</Text>
                        }
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => setShowVkLogin(false)} style={styles.iconBtn}>
                        <X size={16} color={Colors.textSecondary} />
                      </TouchableOpacity>
                    </View>
                    <Text style={styles.hint}>Credentials are sent to your local server only.</Text>
                  </>
                ) : (
                  <View style={{ gap: Spacing.sm }}>
                    <TouchableOpacity
                      onPress={doVkOAuthLogin}
                      style={[styles.testBtn, { marginTop: 0 }]}
                      disabled={vkLoggingIn}
                    >
                      {vkLoggingIn ? (
                        <ActivityIndicator size="small" color={Colors.accentPurple} />
                      ) : (
                        <>
                          <Globe size={14} color={Colors.accentPurple} />
                          <Text style={[styles.testBtnText, { color: Colors.accentPurple }]}>Login via Browser</Text>
                        </>
                      )}
                    </TouchableOpacity>
                    {vkLoggingIn && (
                      <Text style={styles.hint}>Waiting for authorization... Return here after logging in.</Text>
                    )}
                    {!vkLoggingIn && (
                      <TouchableOpacity onPress={() => setShowVkLogin(true)} style={styles.testBtn}>
                        <LogIn size={14} color={Colors.textTertiary} />
                        <Text style={[styles.testBtnText, { color: Colors.textTertiary }]}>Login with password</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
              </GlassCard>

              {/* VK Playlists */}
              {vkAuthenticated && (
                <GlassCard style={[styles.serverCard, { marginTop: Spacing.sm }]}>
                  <View style={styles.serverHeader}>
                    <List size={18} color={Colors.accentPurple} />
                    <Text style={styles.serverTitle}>VK Playlists</Text>
                    <TouchableOpacity onPress={loadVkPlaylists} style={styles.badgeBtn} disabled={loadingPlaylists}>
                      {loadingPlaylists
                        ? <ActivityIndicator size="small" color={Colors.accentPrimary} />
                        : <Text style={styles.badgeBtnText}>Load</Text>
                      }
                    </TouchableOpacity>
                  </View>
                  {vkPlaylists.length === 0 ? (
                    <Text style={styles.hint}>Tap Load to fetch your VK playlists.</Text>
                  ) : (
                    vkPlaylists.map((pl) => (
                      <View key={pl.id} style={styles.playlistRow}>
                        <Text style={styles.playlistTitle} numberOfLines={1}>{pl.title}</Text>
                        <Text style={styles.playlistCount}>{pl.count}</Text>
                        <TouchableOpacity
                          onPress={() => importVkPlaylist(pl.id, pl.owner_id, pl.title)}
                          style={styles.importBtn}
                          disabled={importingPlaylist === pl.id}
                        >
                          {importingPlaylist === pl.id
                            ? <ActivityIndicator size="small" color={Colors.accentPrimary} />
                            : <Download size={14} color={Colors.accentPrimary} />
                          }
                        </TouchableOpacity>
                      </View>
                    ))
                  )}
                </GlassCard>
              )}
            </>
          )}

          {/* ── Audio Quality ── */}
          <SectionLabel label="Audio Quality" />

          <GlassCard style={styles.toggleCard}>
            {(['low', 'medium', 'high'] as StreamQuality[]).map((q, i, arr) => (
              <TouchableOpacity
                key={q}
                style={[styles.toggleRow, i < arr.length - 1 && styles.toggleDivider]}
                onPress={() => setStreamQuality(q)}
              >
                <Volume2 size={16} color={Colors.textSecondary} />
                <Text style={styles.toggleLabel}>
                  {q === 'low' ? 'Low (128 kbps)' : q === 'medium' ? 'Medium (192 kbps)' : 'High (320 kbps)'}
                </Text>
                {streamQuality === q && (
                  <Check size={16} color={Colors.accentPrimary} />
                )}
              </TouchableOpacity>
            ))}
          </GlassCard>

          {/* ── Tools ── */}
          <SectionLabel label="Tools" />

          <RowItem
            icon={BarChart2}
            label="Your Stats"
            onPress={() => navigation.navigate('Stats')}
            iconColor={Colors.accentPurple}
          />
          <View style={{ height: Spacing.sm }} />
          <RowItem
            icon={Sliders}
            label="Equalizer"
            onPress={() => setShowEqualizer(true)}
            iconColor={Colors.accentPrimary}
          />

          {/* ── Playback ── */}
          <SectionLabel label="Playback" />

          <GlassCard style={styles.toggleCard}>
            <View style={styles.toggleRow}>
              <Sliders size={16} color={Colors.textSecondary} />
              <Text style={styles.toggleLabel}>Crossfade</Text>
              <TouchableOpacity onPress={cycleCrossfade} style={styles.chipBtn}>
                <Text style={styles.chipText}>{crossfadeSec === 0 ? 'Off' : `${crossfadeSec}s`}</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.toggleRow, styles.toggleDivider]}>
              <Music2 size={16} color={Colors.textSecondary} />
              <Text style={styles.toggleLabel}>Gapless Playback</Text>
              <Switch
                value={gapless}
                onValueChange={setGapless}
                trackColor={{ false: 'rgba(255,255,255,0.1)', true: Colors.accentPrimary + '66' }}
                thumbColor={gapless ? Colors.accentPrimary : Colors.textTertiary}
              />
            </View>
            <View style={[styles.toggleRow, styles.toggleDivider]}>
              <Settings size={16} color={Colors.textSecondary} />
              <Text style={styles.toggleLabel}>Volume Normalization</Text>
              <Switch
                value={normalization}
                onValueChange={setNormalization}
                trackColor={{ false: 'rgba(255,255,255,0.1)', true: Colors.accentPrimary + '66' }}
                thumbColor={normalization ? Colors.accentPrimary : Colors.textTertiary}
              />
            </View>
          </GlassCard>

          {/* ── Storage ── */}
          <SectionLabel label="Storage" />

          <RowItem
            icon={HardDrive}
            label="Cache Size"
            value={cacheSize ?? 'Tap to check'}
            onPress={loadCacheSize}
          />
          <View style={{ height: Spacing.sm }} />
          <RowItem
            icon={Trash2}
            label="Clear Cache"
            onPress={clearCache}
            danger
          />

          {/* ── Debug ── */}
          <SectionLabel label="Debug" />

          <RowItem
            icon={Bug}
            label="Reset Onboarding"
            onPress={() => {
              Alert.alert('Reset Onboarding', 'This will show the onboarding wizard on next launch.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Reset', style: 'destructive', onPress: resetOnboarding },
              ]);
            }}
            danger
          />

          {/* ── Server Connection ── */}
          <SectionLabel label="Server" />

          <GlassCard style={styles.serverCard}>
            <View style={styles.serverHeader}>
              <Server size={18} color={Colors.accentPrimary} />
              <Text style={styles.serverTitle}>Mac Server</Text>
              <View style={styles.serverBadgeRow}>
                {connectionOk === true && (
                  <View style={[styles.statusDot, { backgroundColor: Colors.accentGreen }]} />
                )}
                {connectionOk === false && (
                  <View style={[styles.statusDot, { backgroundColor: Colors.accentPrimary }]} />
                )}
                {isCustom && (
                  <TouchableOpacity onPress={resetServer} style={styles.badgeBtn}>
                    <Text style={styles.badgeBtnText}>Reset</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>

            {editingServer ? (
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={serverDraft}
                  onChangeText={setServerDraft}
                  placeholder="192.168.x.x:3001"
                  placeholderTextColor={Colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                  onSubmitEditing={saveServer}
                  autoFocus
                />
                <TouchableOpacity onPress={saveServer} style={styles.iconBtn}>
                  <Check size={16} color={Colors.accentGreen} />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setEditingServer(false)} style={styles.iconBtn}>
                  <X size={16} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={startEditingServer} style={styles.urlRow}>
                <Text style={styles.urlText} numberOfLines={1}>{currentUrl}</Text>
                {isCustom && <View style={styles.customBadge}><Text style={styles.customBadgeText}>Custom</Text></View>}
              </TouchableOpacity>
            )}

            <TouchableOpacity onPress={testConnection} style={styles.testBtn} disabled={testingConnection}>
              <Wifi size={14} color={Colors.textSecondary} />
              <Text style={styles.testBtnText}>
                {testingConnection ? 'Testing…' : connectionOk === true ? 'Connected' : connectionOk === false ? 'Failed' : 'Test Connection'}
              </Text>
            </TouchableOpacity>
          </GlassCard>

          {/* ── About ── */}
          <SectionLabel label="About" />

          <GlassCard style={styles.aboutCard}>
            <Text style={styles.aboutName}>Musaic</Text>
            <Text style={styles.aboutVersion}>Version 1.0.0</Text>
            <Text style={styles.aboutDesc}>
              Your personal music player — local library, VK, and SoundCloud in one place.
            </Text>
          </GlassCard>
        </ScrollView>
      </SafeAreaView>
      <EqualizerSheet visible={showEqualizer} onClose={() => setShowEqualizer(false)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
  safeArea: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing['3xl'],
  },
  heading: {
    ...Typography.headingXl,
    color: Colors.textPrimary,
    marginTop: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  sectionLabel: {
    ...Typography.caption,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.sm,
    marginTop: Spacing.xl,
  },
  // Server
  serverCard: {
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  serverHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  serverTitle: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
    flex: 1,
  },
  serverBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  badgeBtn: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(233,30,140,0.35)',
  },
  badgeBtnText: {
    ...Typography.caption,
    color: Colors.accentPrimary,
  },
  urlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.glassBgActive,
    borderRadius: Radius.sm,
  },
  urlText: {
    ...Typography.body,
    color: Colors.textSecondary,
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  customBadge: {
    paddingHorizontal: Spacing.xs + 2,
    paddingVertical: 1,
    backgroundColor: 'rgba(233,30,140,0.15)',
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(233,30,140,0.30)',
  },
  customBadgeText: {
    ...Typography.caption,
    color: Colors.accentPrimary,
  },
  testBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    paddingVertical: Spacing.xs,
  },
  testBtnText: {
    ...Typography.caption,
    color: Colors.textTertiary,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  input: {
    flex: 1,
    ...Typography.body,
    color: Colors.textPrimary,
    backgroundColor: Colors.glassBgActive,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  iconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.glassBg,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  hint: {
    ...Typography.bodySm,
    color: Colors.textTertiary,
  },
  // Toggles
  toggleCard: {
    overflow: 'hidden',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  toggleDivider: {
    borderTopWidth: 1,
    borderTopColor: Colors.glassBorder,
  },
  toggleLabel: {
    ...Typography.body,
    color: Colors.textPrimary,
    flex: 1,
  },
  chipBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    backgroundColor: Colors.glassBgActive,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  chipText: {
    ...Typography.bodySm,
    color: Colors.accentPrimary,
  },
  // Row items
  rowCard: {
    marginBottom: Spacing.sm,
  },
  rowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  rowLabel: {
    ...Typography.body,
    color: Colors.textPrimary,
    flex: 1,
  },
  dangerText: {
    color: Colors.accentPrimary,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  rowValue: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
  },
  // About
  aboutCard: {
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.xs,
  },
  aboutName: {
    ...Typography.headingMd,
    color: Colors.textPrimary,
  },
  aboutVersion: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
  },
  aboutDesc: {
    ...Typography.bodySm,
    color: Colors.textTertiary,
    textAlign: 'center',
    marginTop: Spacing.xs,
  },
  // VK Playlists
  playlistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.glassBorder,
    gap: Spacing.sm,
  },
  playlistTitle: {
    ...Typography.body,
    color: Colors.textPrimary,
    flex: 1,
  },
  playlistCount: {
    ...Typography.caption,
    color: Colors.textTertiary,
  },
  importBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.glassBg,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
});
