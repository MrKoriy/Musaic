import React, { useState, useCallback } from 'react';
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
} from 'react-native';
import { User, Settings, Bell, ChevronRight, Server, Check, X } from 'lucide-react-native';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { SERVER_URL, setServerUrl, clearServerUrl, getStoredServerUrl } from '../services/apiService';

const MENU_ITEMS = [
  { icon: Bell, label: 'Notifications' },
];

export function ProfileScreen() {
  const [customUrl, setCustomUrl] = useState(getStoredServerUrl() ?? '');
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const currentUrl = SERVER_URL;
  const isCustom = !!getStoredServerUrl();

  const startEditing = useCallback(() => {
    setDraft(getStoredServerUrl() ?? '');
    setIsEditing(true);
  }, []);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setDraft('');
  }, []);

  const saveUrl = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) {
      Alert.alert('Invalid URL', 'Please enter a valid IP or URL.');
      return;
    }
    // Normalize: if no protocol, prepend http://
    let url = trimmed;
    if (!url.startsWith('http')) {
      // If it looks like "192.168.x.x" or "192.168.x.x:3001"
      url = `http://${url}`;
    }
    // If no port, append default port 3001
    if (!/:\d+$/.test(url.replace(/^https?:\/\//, ''))) {
      url = `${url}:3001`;
    }
    setServerUrl(url);
    setCustomUrl(url);
    setIsEditing(false);
    setDraft('');
    Alert.alert('Saved', `Server set to:\n${url}`);
  }, [draft]);

  const clearUrl = useCallback(() => {
    Alert.alert(
      'Clear Server URL',
      'Reset to auto-detection (same WiFi required)?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            clearServerUrl();
            setCustomUrl('');
            setIsEditing(false);
          },
        },
      ]
    );
  }, []);

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
          <Text style={styles.heading}>Profile</Text>

          {/* Avatar */}
          <View style={styles.avatarSection}>
            <GlassCard style={styles.avatar} borderRadius={Radius.full}>
              <View style={styles.avatarInner}>
                <User size={40} color={Colors.textSecondary} />
              </View>
            </GlassCard>
            <Text style={styles.userName}>Music Lover</Text>
            <Text style={styles.userMeta}>Personal Library</Text>
          </View>

          {/* Server Configuration */}
          <Text style={styles.sectionLabel}>Server</Text>
          <GlassCard style={styles.serverCard}>
            <View style={styles.serverHeader}>
              <Server size={18} color={Colors.accentPrimary} />
              <Text style={styles.serverTitle}>Mac Server</Text>
              {isCustom ? (
                <TouchableOpacity onPress={clearUrl} style={styles.clearBtn}>
                  <Text style={styles.clearBtnText}>Reset</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {isEditing ? (
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="192.168.x.x or http://192.168.x.x:3001"
                  placeholderTextColor={Colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                  onSubmitEditing={saveUrl}
                  autoFocus
                />
                <TouchableOpacity onPress={saveUrl} style={styles.iconBtn}>
                  <Check size={18} color={Colors.accentGreen} />
                </TouchableOpacity>
                <TouchableOpacity onPress={cancelEditing} style={styles.iconBtn}>
                  <X size={18} color={Colors.textSecondary} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={startEditing} style={styles.urlRow}>
                <Text style={styles.urlText} numberOfLines={1}>
                  {isCustom ? customUrl || currentUrl : currentUrl}
                </Text>
                {isCustom && (
                  <View style={styles.customBadge}>
                    <Text style={styles.customBadgeText}>Custom</Text>
                  </View>
                )}
              </TouchableOpacity>
            )}

            <Text style={styles.serverHint}>
              {isCustom
                ? 'Using custom server address. Tap URL to edit.'
                : 'Auto-detected. Tap to set a manual IP if on cellular/different network.'}
            </Text>
          </GlassCard>

          {/* Menu Items */}
          <Text style={styles.sectionLabel}>Settings</Text>
          {MENU_ITEMS.map(({ icon: Icon, label }) => (
            <TouchableOpacity key={label}>
              <GlassCard style={styles.menuItem}>
                <View style={styles.menuRow}>
                  <Icon size={20} color={Colors.textSecondary} />
                  <Text style={styles.menuLabel}>{label}</Text>
                  <ChevronRight size={16} color={Colors.textTertiary} />
                </View>
              </GlassCard>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </SafeAreaView>
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
  avatarSection: {
    alignItems: 'center',
    marginBottom: Spacing['2xl'],
  },
  avatar: {
    marginBottom: Spacing.md,
  },
  avatarInner: {
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  userName: {
    ...Typography.headingMd,
    color: Colors.textPrimary,
    marginBottom: Spacing.xs,
  },
  userMeta: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
  },
  sectionLabel: {
    ...Typography.caption,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.sm,
    marginTop: Spacing.md,
  },
  serverCard: {
    padding: Spacing.lg,
    marginBottom: Spacing.md,
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
  clearBtn: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(233,30,140,0.35)',
  },
  clearBtnText: {
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
  serverHint: {
    ...Typography.bodySm,
    color: Colors.textTertiary,
    lineHeight: 17,
  },
  menuItem: {
    marginBottom: Spacing.sm,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  menuLabel: {
    ...Typography.body,
    color: Colors.textPrimary,
    flex: 1,
  },
});
