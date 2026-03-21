import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
} from 'react-native';
import { X, Check } from 'lucide-react-native';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { api } from '../services/apiService';

interface Props {
  visible: boolean;
  playlistId: string;
  initialName: string;
  initialDescription?: string;
  onClose: () => void;
  onSaved: (name: string, description: string) => void;
}

export function PlaylistEditor({
  visible,
  playlistId,
  initialName,
  initialDescription = '',
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state when props change (e.g., opening editor for a different playlist)
  useEffect(() => {
    setName(initialName);
    setDescription(initialDescription);
    setError(null);
  }, [initialName, initialDescription]);

  async function handleSave() {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updatePlaylist(playlistId, { name: name.trim(), description });
      onSaved(name.trim(), description);
    } catch {
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    setName(initialName);
    setDescription(initialDescription);
    setError(null);
    onClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.kvContainer}
        >
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.title}>Edit Playlist</Text>
              <TouchableOpacity onPress={handleClose} hitSlop={8}>
                <X size={20} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Name */}
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Playlist name"
              placeholderTextColor={Colors.textTertiary}
              maxLength={100}
              autoFocus
            />

            {/* Description */}
            <Text style={styles.label}>Description</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={description}
              onChangeText={setDescription}
              placeholder="Optional description"
              placeholderTextColor={Colors.textTertiary}
              multiline
              numberOfLines={3}
              maxLength={300}
            />

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            {/* Actions */}
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={handleClose}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
                onPress={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={Colors.bgPrimary} />
                ) : (
                  <>
                    <Check size={16} color={Colors.bgPrimary} />
                    <Text style={styles.saveText}>Save</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  kvContainer: {
    justifyContent: 'center',
  },
  sheet: {
    backgroundColor: Colors.bgSecondary,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  title: {
    ...Typography.headingMd,
    color: Colors.textPrimary,
  },
  label: {
    ...Typography.caption,
    color: Colors.textSecondary,
    marginBottom: Spacing.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: Colors.bgTertiary,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
    color: Colors.textPrimary,
    ...Typography.body,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    marginBottom: Spacing.md,
  },
  textArea: {
    height: 80,
    textAlignVertical: 'top',
    paddingTop: Spacing.sm,
  },
  errorText: {
    ...Typography.caption,
    color: '#ff6b6b',
    marginBottom: Spacing.sm,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginTop: Spacing.xs,
  },
  cancelBtn: {
    flex: 1,
    height: 44,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.bgTertiary,
    borderWidth: 1,
    borderColor: Colors.glassBorder,
  },
  cancelText: {
    ...Typography.body,
    color: Colors.textSecondary,
  },
  saveBtn: {
    flex: 1,
    height: 44,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: Spacing.xs,
    backgroundColor: Colors.accentPrimary,
  },
  saveBtnDisabled: {
    opacity: 0.6,
  },
  saveText: {
    ...Typography.headingSm,
    color: Colors.bgPrimary,
  },
});
