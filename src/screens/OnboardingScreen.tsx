import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput,
  ScrollView, ActivityIndicator, SafeAreaView, Switch,
  Animated, Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Music, Wifi, FolderOpen, Radio, ScanLine, CheckCircle, ChevronRight } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { GlassCard } from '../components/GlassCard';
import { RootStackParamList } from '../types';
import { useSettingsStore } from '../stores/useSettingsStore';
import { setServerUrl, api } from '../services/apiService';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

type Step = 'welcome' | 'server' | 'folder' | 'sources' | 'scan';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export function OnboardingScreen() {
  const navigation = useNavigation<NavProp>();
  const { sources, toggleSource, completeOnboarding } = useSettingsStore();

  const [step, setStep] = useState<Step>('welcome');
  const [serverIp, setServerIp] = useState('');
  const [testingConn, setTestingConn] = useState(false);
  const [connStatus, setConnStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const [folderPath, setFolderPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const slideAnim = useRef(new Animated.Value(0)).current;

  const STEPS: Step[] = ['welcome', 'server', 'folder', 'sources', 'scan'];
  const stepIdx = STEPS.indexOf(step);
  const progress = (stepIdx + 1) / STEPS.length;

  function animateNext() {
    Animated.sequence([
      Animated.timing(slideAnim, { toValue: -SCREEN_WIDTH, duration: 200, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: SCREEN_WIDTH, duration: 0, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start();
  }

  function goTo(next: Step) {
    animateNext();
    setStep(next);
  }

  async function handleTestConnection() {
    const ip = serverIp.trim();
    if (!ip) return;
    setTestingConn(true);
    setConnStatus('idle');
    const url = ip.startsWith('http') ? ip : `http://${ip}:3001`;
    setServerUrl(url);
    const ok = await api.ping();
    setConnStatus(ok ? 'ok' : 'fail');
    setTestingConn(false);
  }

  async function handleScan() {
    setScanning(true);
    try {
      if (folderPath.trim()) {
        await api.scanFolder(folderPath.trim());
        const poll = setInterval(async () => {
          try {
            const status = await api.getScanStatus();
            if (!status.scanning) {
              clearInterval(poll);
              setScanning(false);
              setScanDone(true);
            }
          } catch {
            clearInterval(poll);
            setScanning(false);
            setScanDone(true);
          }
        }, 1500);
      } else {
        setScanning(false);
        setScanDone(true);
      }
    } catch {
      setScanning(false);
      setScanDone(true);
    }
  }

  function handleFinish() {
    completeOnboarding();
    navigation.replace('MainTabs');
  }

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['rgba(233, 30, 140, 0.15)', 'transparent', 'rgba(124, 58, 237, 0.10)']}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      <SafeAreaView style={styles.safeArea}>
        {/* Progress bar */}
        {step !== 'welcome' && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
        )}

        <Animated.View style={[styles.content, { transform: [{ translateX: slideAnim }] }]}>
          {step === 'welcome' && (
            <WelcomeStep onNext={() => goTo('server')} />
          )}
          {step === 'server' && (
            <ServerStep
              ip={serverIp}
              onChangeIp={setServerIp}
              onTest={handleTestConnection}
              testing={testingConn}
              status={connStatus}
              onNext={() => goTo('folder')}
            />
          )}
          {step === 'folder' && (
            <FolderStep
              path={folderPath}
              onChangePath={setFolderPath}
              onNext={() => goTo('sources')}
            />
          )}
          {step === 'sources' && (
            <SourcesStep
              sources={sources}
              onToggle={toggleSource}
              onNext={() => goTo('scan')}
            />
          )}
          {step === 'scan' && (
            <ScanStep
              folderPath={folderPath}
              scanning={scanning}
              done={scanDone}
              onScan={handleScan}
              onFinish={handleFinish}
            />
          )}
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

// ─── Step components ──────────────────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <View style={styles.step}>
      <View style={styles.logoWrap}>
        <View style={styles.logoCircle}>
          <Music size={48} color={Colors.accentPrimary} />
        </View>
      </View>
      <Text style={styles.title}>Welcome to Musaic</Text>
      <Text style={styles.subtitle}>
        Your personal music player for local FLAC libraries, VK, and SoundCloud.
        Let's set things up.
      </Text>
      <TouchableOpacity style={styles.primaryBtn} onPress={onNext} activeOpacity={0.85}>
        <Text style={styles.primaryBtnText}>Get Started</Text>
        <ChevronRight size={18} color={Colors.bgPrimary} />
      </TouchableOpacity>
    </View>
  );
}

function ServerStep({ ip, onChangeIp, onTest, testing, status, onNext }: {
  ip: string; onChangeIp: (v: string) => void;
  onTest: () => void; testing: boolean;
  status: 'idle' | 'ok' | 'fail'; onNext: () => void;
}) {
  return (
    <View style={styles.step}>
      <View style={styles.stepIcon}><Wifi size={36} color={Colors.accentPrimary} /></View>
      <Text style={styles.title}>Connect to Server</Text>
      <Text style={styles.subtitle}>
        Enter your Mac's IP address. The Musaic server must be running on port 3001.
      </Text>
      <GlassCard style={styles.inputCard}>
        <TextInput
          value={ip}
          onChangeText={onChangeIp}
          placeholder="192.168.1.100"
          placeholderTextColor={Colors.textTertiary}
          style={styles.input}
          keyboardType="default"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </GlassCard>
      {status !== 'idle' && (
        <Text style={[styles.statusText, status === 'ok' ? styles.statusOk : styles.statusFail]}>
          {status === 'ok' ? '✓ Connected successfully' : '✗ Could not reach server'}
        </Text>
      )}
      <TouchableOpacity
        style={[styles.secondaryBtn, testing && styles.btnDisabled]}
        onPress={onTest}
        disabled={testing}
      >
        {testing ? (
          <ActivityIndicator color={Colors.accentPrimary} size="small" />
        ) : (
          <Text style={styles.secondaryBtnText}>Test Connection</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity style={styles.primaryBtn} onPress={onNext} activeOpacity={0.85}>
        <Text style={styles.primaryBtnText}>{ip.trim() ? 'Continue' : 'Skip for now'}</Text>
        <ChevronRight size={18} color={Colors.bgPrimary} />
      </TouchableOpacity>
    </View>
  );
}

function FolderStep({ path, onChangePath, onNext }: {
  path: string; onChangePath: (v: string) => void; onNext: () => void;
}) {
  return (
    <View style={styles.step}>
      <View style={styles.stepIcon}><FolderOpen size={36} color={Colors.accentPrimary} /></View>
      <Text style={styles.title}>Music Folder</Text>
      <Text style={styles.subtitle}>
        Enter the path to your music library on the Mac running the server.
      </Text>
      <GlassCard style={styles.inputCard}>
        <TextInput
          value={path}
          onChangeText={onChangePath}
          placeholder="/Users/you/Music/FLAC"
          placeholderTextColor={Colors.textTertiary}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </GlassCard>
      <TouchableOpacity style={styles.primaryBtn} onPress={onNext} activeOpacity={0.85}>
        <Text style={styles.primaryBtnText}>{path.trim() ? 'Continue' : 'Skip for now'}</Text>
        <ChevronRight size={18} color={Colors.bgPrimary} />
      </TouchableOpacity>
    </View>
  );
}

function SourcesStep({ sources, onToggle, onNext }: {
  sources: { local: boolean; vk: boolean; soundcloud: boolean };
  onToggle: (s: 'local' | 'vk' | 'soundcloud') => void;
  onNext: () => void;
}) {
  const items: Array<{ key: 'local' | 'vk' | 'soundcloud'; label: string; desc: string }> = [
    { key: 'local', label: 'Local FLAC/MP3', desc: 'Your personal library on Mac' },
    { key: 'vk', label: 'VK Music', desc: 'Stream from VK social network' },
    { key: 'soundcloud', label: 'SoundCloud', desc: 'Millions of free tracks' },
  ];
  return (
    <View style={styles.step}>
      <View style={styles.stepIcon}><Radio size={36} color={Colors.accentPrimary} /></View>
      <Text style={styles.title}>Music Sources</Text>
      <Text style={styles.subtitle}>Choose which sources to enable. You can change this later.</Text>
      <View style={styles.sourceList}>
        {items.map(({ key, label, desc }) => (
          <GlassCard key={key} style={styles.sourceRow}>
            <View style={styles.sourceInfo}>
              <Text style={styles.sourceLabel}>{label}</Text>
              <Text style={styles.sourceDesc}>{desc}</Text>
            </View>
            <Switch
              value={sources[key]}
              onValueChange={() => onToggle(key)}
              trackColor={{ false: Colors.bgTertiary, true: Colors.accentPrimary + '99' }}
              thumbColor={sources[key] ? Colors.accentPrimary : Colors.textTertiary}
              disabled={key === 'local'}
            />
          </GlassCard>
        ))}
      </View>
      <TouchableOpacity style={styles.primaryBtn} onPress={onNext} activeOpacity={0.85}>
        <Text style={styles.primaryBtnText}>Continue</Text>
        <ChevronRight size={18} color={Colors.bgPrimary} />
      </TouchableOpacity>
    </View>
  );
}

function ScanStep({ folderPath, scanning, done, onScan, onFinish }: {
  folderPath: string; scanning: boolean; done: boolean;
  onScan: () => void; onFinish: () => void;
}) {
  return (
    <View style={styles.step}>
      <View style={styles.stepIcon}>
        {done
          ? <CheckCircle size={36} color={Colors.accentGreen} />
          : <ScanLine size={36} color={Colors.accentPrimary} />}
      </View>
      <Text style={styles.title}>{done ? 'All Set!' : 'Scan Your Music'}</Text>
      <Text style={styles.subtitle}>
        {done
          ? "Musaic is ready. Your library will appear in the Library tab."
          : folderPath.trim()
            ? `Ready to scan: ${folderPath}`
            : "Skip this step — you can scan from the Library tab anytime."}
      </Text>

      {scanning && (
        <View style={styles.scanningRow}>
          <ActivityIndicator color={Colors.accentPrimary} />
          <Text style={styles.scanningText}>Scanning your library…</Text>
        </View>
      )}

      {!done && !scanning && (
        <>
          {folderPath.trim() && (
            <TouchableOpacity style={styles.secondaryBtn} onPress={onScan}>
              <ScanLine size={16} color={Colors.accentPrimary} />
              <Text style={styles.secondaryBtnText}>Start Scan</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.primaryBtn, { marginTop: Spacing.sm }]} onPress={onFinish} activeOpacity={0.85}>
            <Text style={styles.primaryBtnText}>{folderPath.trim() ? 'Skip Scan' : 'Go to App'}</Text>
            <ChevronRight size={18} color={Colors.bgPrimary} />
          </TouchableOpacity>
        </>
      )}

      {done && (
        <TouchableOpacity style={styles.primaryBtn} onPress={onFinish} activeOpacity={0.85}>
          <Text style={styles.primaryBtnText}>Open Musaic</Text>
          <ChevronRight size={18} color={Colors.bgPrimary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bgPrimary },
  safeArea: { flex: 1 },
  progressTrack: {
    height: 2, backgroundColor: Colors.glassBg,
    marginHorizontal: Spacing.lg, marginTop: Spacing.md,
    borderRadius: Radius.full,
  },
  progressFill: {
    height: '100%', backgroundColor: Colors.accentPrimary,
    borderRadius: Radius.full,
  },
  content: { flex: 1, justifyContent: 'center' },
  step: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing['2xl'],
    alignItems: 'center',
    gap: Spacing.md,
  },

  // Welcome
  logoWrap: { marginBottom: Spacing.xl },
  logoCircle: {
    width: 96, height: 96, borderRadius: Radius.full,
    backgroundColor: Colors.accentPrimary + '22',
    borderWidth: 1, borderColor: Colors.accentPrimary + '44',
    alignItems: 'center', justifyContent: 'center',
  },
  stepIcon: {
    width: 72, height: 72, borderRadius: Radius.full,
    backgroundColor: Colors.accentPrimary + '22',
    borderWidth: 1, borderColor: Colors.accentPrimary + '44',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  title: {
    ...Typography.headingXl,
    color: Colors.textPrimary,
    textAlign: 'center',
  },
  subtitle: {
    ...Typography.body,
    color: Colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: Spacing.md,
  },

  inputCard: { width: '100%', marginBottom: Spacing.sm },
  input: {
    ...Typography.body,
    color: Colors.textPrimary,
    padding: Spacing.md,
  },

  statusText: { ...Typography.bodySm, marginBottom: Spacing.sm },
  statusOk: { color: Colors.accentGreen },
  statusFail: { color: '#ef4444' },

  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.accentPrimary,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
    borderRadius: Radius.full, width: '100%', justifyContent: 'center',
    marginTop: Spacing.sm,
  },
  primaryBtnText: { ...Typography.headingSm, color: Colors.bgPrimary },
  secondaryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    borderWidth: 1, borderColor: Colors.accentPrimary,
    paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md,
    borderRadius: Radius.full, width: '100%', justifyContent: 'center',
    minHeight: 44,
  },
  secondaryBtnText: { ...Typography.headingSm, color: Colors.accentPrimary },
  btnDisabled: { opacity: 0.6 },

  // Sources
  sourceList: { width: '100%', gap: Spacing.sm, marginBottom: Spacing.md },
  sourceRow: { width: '100%' },
  sourceInfo: { flex: 1, padding: Spacing.md },
  sourceLabel: { ...Typography.headingSm, color: Colors.textPrimary },
  sourceDesc: { ...Typography.bodySm, color: Colors.textSecondary, marginTop: 2 },

  // Scan
  scanningRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.lg,
  },
  scanningText: { ...Typography.body, color: Colors.textSecondary },
});
