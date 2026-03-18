import React, { useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  Image,
  Modal,
  SafeAreaView,
} from 'react-native';
import { X, Trash2, ChevronUp, ChevronDown } from 'lucide-react-native';
import { Colors, Spacing, Typography, Radius } from '../theme';
import { PlayingIndicator } from './PlayingIndicator';
import { usePlayerStore } from '../stores/usePlayerStore';
import { formatDuration } from '../data/mockData';
import { Track } from '../types';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function QueueSheet({ visible, onClose }: Props) {
  const { queue, queueIndex, currentTrack, isPlaying, removeFromQueue, reorderQueue, clearQueue } =
    usePlayerStore();

  const handleRemove = useCallback(
    (trackId: string) => removeFromQueue(trackId),
    [removeFromQueue]
  );

  const handleMoveUp = useCallback(
    (index: number) => {
      if (index > 0) reorderQueue(index, index - 1);
    },
    [reorderQueue]
  );

  const handleMoveDown = useCallback(
    (index: number) => {
      if (index < queue.length - 1) reorderQueue(index, index + 1);
    },
    [reorderQueue]
  );

  const renderItem = ({ item, index }: { item: Track; index: number }) => {
    const isCurrent = item.id === currentTrack?.id;
    return (
      <View style={[styles.row, isCurrent && styles.rowCurrent]}>
        {/* Reorder buttons */}
        <View style={styles.reorderCol}>
          <TouchableOpacity onPress={() => handleMoveUp(index)} style={styles.reorderBtn} disabled={index === 0}>
            <ChevronUp size={14} color={index === 0 ? Colors.textTertiary : Colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleMoveDown(index)} style={styles.reorderBtn} disabled={index === queue.length - 1}>
            <ChevronDown size={14} color={index === queue.length - 1 ? Colors.textTertiary : Colors.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Playing indicator / index */}
        <View style={styles.indexBox}>
          {isCurrent ? (
            <PlayingIndicator playing={isPlaying} size="sm" />
          ) : (
            <Text style={styles.indexText}>{index + 1}</Text>
          )}
        </View>

        {/* Artwork */}
        {item.artwork ? (
          <Image source={{ uri: item.artwork }} style={styles.artwork} />
        ) : (
          <View style={[styles.artwork, { backgroundColor: Colors.bgTertiary }]}>
            <Text style={styles.artworkNote}>♪</Text>
          </View>
        )}

        {/* Info */}
        <View style={styles.info}>
          <Text style={[styles.title, isCurrent && styles.titleCurrent]} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {item.artist}
          </Text>
        </View>

        {/* Duration */}
        {item.duration !== undefined && (
          <Text style={styles.duration}>{formatDuration(item.duration)}</Text>
        )}

        {/* Remove */}
        {!isCurrent && (
          <TouchableOpacity onPress={() => handleRemove(item.id)} style={styles.removeBtn} hitSlop={8}>
            <X size={16} color={Colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>
    );
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
          <TouchableOpacity onPress={onClose} style={styles.doneBtn}>
            <Text style={styles.doneBtnText}>Done</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Queue</Text>
          <TouchableOpacity
            onPress={clearQueue}
            style={styles.clearBtn}
            disabled={queue.length === 0}
          >
            <Trash2 size={18} color={queue.length > 0 ? Colors.accentPrimary : Colors.textTertiary} />
          </TouchableOpacity>
        </View>

        {queue.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Queue is empty</Text>
          </View>
        ) : (
          <FlatList
            data={queue}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
          />
        )}
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
  headerTitle: {
    ...Typography.headingSm,
    color: Colors.textPrimary,
  },
  doneBtn: {
    width: 60,
  },
  doneBtnText: {
    ...Typography.body,
    color: Colors.accentPrimary,
    fontWeight: '600',
  },
  clearBtn: {
    width: 60,
    alignItems: 'flex-end',
  },
  list: {
    paddingVertical: Spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    gap: Spacing.sm,
  },
  rowCurrent: {
    backgroundColor: Colors.glassBgHover,
  },
  reorderCol: {
    width: 20,
    alignItems: 'center',
    gap: 0,
  },
  reorderBtn: {
    padding: 2,
  },
  indexBox: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 14,
  },
  indexText: {
    ...Typography.bodySm,
    color: Colors.textTertiary,
  },
  artwork: {
    width: 40,
    height: 40,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  artworkNote: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.5)',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...Typography.body,
    color: Colors.textPrimary,
    fontWeight: '500',
  },
  titleCurrent: {
    color: Colors.accentPrimary,
  },
  artist: {
    ...Typography.bodySm,
    color: Colors.textSecondary,
  },
  duration: {
    ...Typography.bodySm,
    color: Colors.textTertiary,
    width: 36,
    textAlign: 'right',
  },
  removeBtn: {
    padding: Spacing.xs,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    ...Typography.body,
    color: Colors.textSecondary,
  },
});
