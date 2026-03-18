import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  SafeAreaView,
  TouchableOpacity,
} from 'react-native';
import { User, Settings, Bell, ChevronRight } from 'lucide-react-native';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';

const MENU_ITEMS = [
  { icon: Settings, label: 'Settings' },
  { icon: Bell, label: 'Notifications' },
];

export function ProfileScreen() {
  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
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

          {/* Menu Items */}
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
    </View>
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
