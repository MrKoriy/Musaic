import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  SafeAreaView,
  PanResponder,
  Dimensions,
  TextInput,
  Alert,
} from 'react-native';
import { X, RotateCcw, Save, ChevronDown, Check } from 'lucide-react-native';
import { haptics } from '../utils/haptics';
import { Colors, Spacing, Typography, Radius } from '../theme';
import {
  useAudioStore,
  EQ_BANDS,
  BUILTIN_PRESETS,
  type EQBandFreq,
  type EQPresetName,
} from '../stores/useAudioStore';

const { height: H } = Dimensions.get('window');
const SLIDER_HEIGHT = 140;
const BUILTIN_PRESET_NAMES = Object.keys(BUILTIN_PRESETS) as EQPresetName[];

function formatFreq(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

function EQSlider({
  gain,
  onGainChange,
}: {
  gain: number;
  onGainChange: (g: number) => void;
}) {
  const trackRef = useRef<View>(null);
  const trackY = useRef(0);

  const gainToY = (g: number) =>
    ((12 - g) / 24) * SLIDER_HEIGHT;

  const yToGain = (y: number) =>
    12 - (y / SLIDER_HEIGHT) * 24;

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const relY = e.nativeEvent.pageY - trackY.current;
        const clamped = Math.max(0, Math.min(SLIDER_HEIGHT, relY));
        onGainChange(yToGain(clamped));
        haptics.selection();
      },
      onPanResponderMove: (e) => {
        const relY = e.nativeEvent.pageY - trackY.current;
        const clamped = Math.max(0, Math.min(SLIDER_HEIGHT, relY));
        onGainChange(yToGain(clamped));
      },
    }),
  ).current;

  const thumbY = gainToY(gain);
  const isPositive = gain > 0;
  const isNegative = gain < 0;

  const fillTop = isPositive ? thumbY : SLIDER_HEIGHT / 2;
  const fillHeight = isPositive
    ? SLIDER_HEIGHT / 2 - thumbY
    : isNegative
    ? SLIDER_HEIGHT / 2 - thumbY
    : 0;

  return (
    <View style={styles.sliderCol}>
      <View
        ref={trackRef}
        {...pan.panHandlers}
        style={styles.sliderTrackHit}
        onLayout={(e) => {
          trackRef.current?.measure((_x, _y, _w, _h, _px, py) => {
            trackY.current = py;
          });
          void e;
        }}
      >
        {/* Track */}
        <View style={styles.sliderTrack}>
          {/* Zero line */}
          <View style={styles.sliderZero} />
          {/* Fill */}
          {(isPositive || isNegative) && (
            <View
              style={[
                styles.sliderFill,
                {
                  top: isPositive ? fillTop : SLIDER_HEIGHT / 2,
                  height: Math.abs(fillHeight),
                  backgroundColor: isPositive ? Colors.accentPrimary : Colors.accentPurple,
                },
              ]}
            />
          )}
          {/* Thumb */}
          <View style={[styles.sliderThumb, { top: thumbY - 7 }]} />
        </View>
      </View>
      {/* dB label */}
      <Text style={styles.gainLabel}>
        {gain > 0 ? `+${gain}` : gain}
      </Text>
    </View>
  );
}

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function EqualizerSheet({ visible, onClose }: Props) {
  const {
    eqEnabled,
    eqBands,
    activePreset,
    bassBoost,
    customPresets,
    setEqEnabled,
    setBandGain,
    applyPreset,
    setBassBoost,
    saveCustomPreset,
    deleteCustomPreset,
    resetEq,
  } = useAudioStore();

  const [showSaveModal, setShowSaveModal] = useState(false);
  const [presetName, setPresetName] = useState('');

  const allPresets = [
    ...BUILTIN_PRESET_NAMES,
    ...customPresets.map((p) => p.name),
  ];

  const bassBarWidth = useRef(0);
  const bassPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        if (bassBarWidth.current <= 0) return;
        const x = e.nativeEvent.locationX;
        setBassBoost(Math.round(Math.max(0, Math.min(1, x / bassBarWidth.current)) * 10));
      },
      onPanResponderMove: (e) => {
        if (bassBarWidth.current <= 0) return;
        const x = e.nativeEvent.locationX;
        setBassBoost(Math.round(Math.max(0, Math.min(1, x / bassBarWidth.current)) * 10));
      },
    }),
  ).current;

  const handleReset = () => {
    Alert.alert('Reset EQ', 'Reset all bands and bass boost to defaults?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset', style: 'destructive', onPress: resetEq },
    ]);
  };

  const handleSave = () => {
    const name = presetName.trim();
    if (!name) return;
    saveCustomPreset(name);
    setShowSaveModal(false);
    setPresetName('');
    haptics.success();
  };

  const handleDeleteCustom = (name: string) => {
    Alert.alert('Delete Preset', `Delete "${name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteCustomPreset(name) },
    ]);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.root}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleReset} style={styles.headerBtn}>
            <RotateCcw size={18} color={Colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.title}>Equalizer</Text>
          <TouchableOpacity onPress={onClose} style={styles.headerBtn}>
            <X size={20} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Enable toggle */}
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Equalizer</Text>
          <TouchableOpacity
            onPress={() => setEqEnabled(!eqEnabled)}
            style={[styles.toggle, eqEnabled && styles.toggleOn]}
            activeOpacity={0.8}
          >
            <View style={[styles.toggleKnob, eqEnabled && styles.toggleKnobOn]} />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: Spacing['2xl'] }}
          showsVerticalScrollIndicator={false}
        >
          {/* EQ Bands */}
          <View style={[styles.section, !eqEnabled && styles.disabled]}>
            <View style={styles.eqContainer}>
              {EQ_BANDS.map((freq) => (
                <View key={freq} style={styles.bandCol}>
                  <EQSlider
                    gain={eqBands[freq]}
                    onGainChange={(g) => setBandGain(freq as EQBandFreq, g)}
                  />
                  <Text style={styles.freqLabel}>{formatFreq(freq)}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* Presets */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Presets</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.presetRow}>
                {allPresets.map((name) => {
                  const isActive = activePreset === name;
                  const isCustom = customPresets.some((p) => p.name === name);
                  return (
                    <TouchableOpacity
                      key={name}
                      onPress={() => applyPreset(name as EQPresetName)}
                      onLongPress={() => isCustom && handleDeleteCustom(name)}
                      style={[styles.presetChip, isActive && styles.presetChipActive]}
                      activeOpacity={0.7}
                    >
                      {isActive && <Check size={12} color="#fff" style={{ marginRight: 4 }} />}
                      <Text style={[styles.presetLabel, isActive && styles.presetLabelActive]}>
                        {name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}

                {/* Save custom */}
                <TouchableOpacity
                  onPress={() => setShowSaveModal(true)}
                  style={styles.presetChipSave}
                  activeOpacity={0.7}
                >
                  <Save size={12} color={Colors.accentPrimary} style={{ marginRight: 4 }} />
                  <Text style={[styles.presetLabel, { color: Colors.accentPrimary }]}>Save</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>

          {/* Bass Boost */}
          <View style={[styles.section, !eqEnabled && styles.disabled]}>
            <View style={styles.rowBetween}>
              <Text style={styles.sectionTitle}>Bass Boost</Text>
              <Text style={styles.valueLabel}>{bassBoost}/10</Text>
            </View>
            <View
              {...bassPan.panHandlers}
              style={styles.bassHitArea}
              onLayout={(e) => { bassBarWidth.current = e.nativeEvent.layout.width; }}
            >
              <View style={styles.bassBg}>
                <View
                  style={[
                    styles.bassFill,
                    { width: `${bassBoost * 10}%` as `${number}%` },
                  ]}
                />
              </View>
            </View>
          </View>
        </ScrollView>

        {/* Save Preset Modal */}
        <Modal
          visible={showSaveModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowSaveModal(false)}
        >
          <View style={styles.saveOverlay}>
            <View style={styles.saveDialog}>
              <Text style={styles.saveTitle}>Save Preset</Text>
              <TextInput
                value={presetName}
                onChangeText={setPresetName}
                placeholder="Preset name"
                placeholderTextColor={Colors.textTertiary}
                style={styles.saveInput}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleSave}
              />
              <View style={styles.saveActions}>
                <TouchableOpacity
                  onPress={() => { setShowSaveModal(false); setPresetName(''); }}
                  style={styles.saveBtn}
                >
                  <Text style={{ color: Colors.textSecondary, ...Typography.button }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleSave}
                  style={[styles.saveBtn, styles.saveBtnPrimary]}
                >
                  <Text style={{ color: '#fff', ...Typography.button }}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.bgPrimary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.glassBorder,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    ...Typography.headingMd,
    color: Colors.textPrimary,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.glassBorder,
  },
  toggleLabel: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
  },
  toggle: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.bgTertiary,
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  toggleOn: {
    backgroundColor: Colors.accentPrimary,
  },
  toggleKnob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.textSecondary,
  },
  toggleKnobOn: {
    backgroundColor: '#fff',
    alignSelf: 'flex-end',
  },
  section: {
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
  },
  disabled: {
    opacity: 0.4,
    pointerEvents: 'none',
  },
  sectionTitle: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  eqContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingVertical: Spacing.sm,
  },
  bandCol: {
    alignItems: 'center',
    flex: 1,
  },
  sliderCol: {
    alignItems: 'center',
  },
  sliderTrackHit: {
    width: 28,
    height: SLIDER_HEIGHT + 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
  },
  sliderTrack: {
    width: 4,
    height: SLIDER_HEIGHT,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 2,
    position: 'relative',
    overflow: 'visible',
  },
  sliderZero: {
    position: 'absolute',
    top: SLIDER_HEIGHT / 2 - 0.5,
    left: -4,
    right: -4,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    right: 0,
    borderRadius: 2,
  },
  sliderThumb: {
    position: 'absolute',
    left: -5,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#fff',
    shadowColor: '#fff',
    shadowOpacity: 0.4,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  gainLabel: {
    ...Typography.caption,
    color: Colors.textTertiary,
    marginTop: Spacing.xs,
    textAlign: 'center',
    minWidth: 28,
  },
  freqLabel: {
    ...Typography.caption,
    color: Colors.textTertiary,
    marginTop: Spacing.xs,
    textAlign: 'center',
  },
  presetRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  presetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
    backgroundColor: Colors.glassBg,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  presetChipActive: {
    backgroundColor: Colors.accentPrimary,
    borderColor: Colors.accentPrimary,
  },
  presetChipSave: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accentPrimary,
    borderStyle: 'dashed',
  },
  presetLabel: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
    fontWeight: '600',
  },
  presetLabelActive: {
    color: '#fff',
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  valueLabel: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
  },
  bassHitArea: {
    paddingVertical: Spacing.sm,
  },
  bassBg: {
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 3,
  },
  bassFill: {
    height: 6,
    backgroundColor: Colors.accentPrimary,
    borderRadius: 3,
  },
  saveOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.xl,
  },
  saveDialog: {
    width: '100%',
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  saveTitle: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
    marginBottom: Spacing.lg,
  },
  saveInput: {
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    color: Colors.textPrimary,
    ...Typography.body,
    marginBottom: Spacing.lg,
    backgroundColor: Colors.glassBg,
  },
  saveActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    justifyContent: 'flex-end',
  },
  saveBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  saveBtnPrimary: {
    backgroundColor: Colors.accentPrimary,
  },
});
