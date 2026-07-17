// ConflictResolutionCard — save-time fact-conflict resolver (Wave 11 U-B1). When
// a freshly-saved fact looks like a correction of an existing one (detected
// deterministically by detectFactConflicts — no LLM call), this card lets the
// user pick how to reconcile them. Each verb is an icon + label with a one-line
// result preview; Merge is EDITABLE (the user can tweak the merged statement
// before applying).
//
// Verbs → services (change-log coverage noted for the report):
//   - Keep both (library-add): no mutation — both facts stay. Invertible: n/a.
//   - Replace old (published-with-changes): deletes the OLD fact via
//     fact-service.deleteFact. NOT invertible (fact deletes are not change-logged).
//   - Merge (call-merge): updates the NEW fact's statement to the edited text,
//     reassigns the OLD fact's topic rows to the NEW fact (topic-service.reassignTopics),
//     then deletes the OLD fact. NOT invertible (fact update/delete + reassign are
//     not change-logged).
//   - Dismiss (close): no mutation.
// Settlement is recorded in the floating-chat store (resolvedConflicts), keyed by
// `${newFactId}:${existingFactId}`, mirroring resolvedProposals.

import { Text } from '@/components/ui/text';
import { hapticLight, hapticSuccess } from '@/lib/haptics';
import { deleteFact, updateFact } from '@/lib/database/services/fact-service';
import { reassignTopics } from '@/lib/database/services/topic-service';
import type { FactConflict } from '@/lib/news-harness/persona-management/fact-conflict';
import {
  useFloatingChatResolvedConflicts,
  useFloatingChatStore,
  type ConflictResolution,
} from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';
const WARN = 'rgb(233, 179, 83)';

function cardEntering() {
  'worklet';
  const duration = 280;
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 12 }, { scale: 0.97 }] },
    animations: {
      opacity: withTiming(1, { duration }),
      transform: [
        { translateY: withTiming(0, { duration }) },
        { scale: withTiming(1, { duration }) },
      ],
    },
  };
}

export interface ConflictResolutionCardProps {
  conflict: FactConflict;
}

const STATUS_LABEL_KEY = {
  'kept-both': 'conflict.statusKeptBoth',
  replaced: 'conflict.statusReplaced',
  merged: 'conflict.statusMerged',
  dismissed: 'conflict.statusDismissed',
} as const satisfies Record<ConflictResolution, string>;

const ConflictResolutionCard: React.FC<ConflictResolutionCardProps> = ({ conflict }) => {
  const { t } = useTranslation();
  const conflictKey = `${conflict.newFactId}:${conflict.existingFactId}`;
  const resolvedMap = useFloatingChatResolvedConflicts();
  const resolved = resolvedMap[conflictKey] ?? null;

  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeText, setMergeText] = useState(conflict.suggestedMerge);
  const [busy, setBusy] = useState(false);

  const settle = (resolution: ConflictResolution) => {
    useFloatingChatStore.getState().resolveConflict(conflictKey, resolution);
  };

  const handleKeepBoth = () => {
    hapticLight();
    settle('kept-both');
  };

  const handleDismiss = () => {
    hapticLight();
    settle('dismissed');
  };

  const handleReplace = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteFact(conflict.existingFactId);
      useFloatingChatStore.getState().notifyFactMutation();
      void hapticSuccess();
      settle('replaced');
    } finally {
      setBusy(false);
    }
  };

  const handleApplyMerge = async () => {
    if (busy) return;
    const text = mergeText.trim();
    if (!text) return;
    setBusy(true);
    try {
      // 1) The surviving (new) fact takes the edited merged statement.
      await updateFact(conflict.newFactId, { statement: text });
      // 2) The old fact's topic rows follow the surviving fact.
      await reassignTopics(conflict.existingFactId, conflict.newFactId);
      // 3) Remove the now-merged old fact.
      await deleteFact(conflict.existingFactId);
      useFloatingChatStore.getState().notifyFactMutation();
      void hapticSuccess();
      settle('merged');
    } finally {
      setBusy(false);
    }
  };

  const dimmed = resolved !== null;

  return (
    <Animated.View entering={cardEntering} style={[styles.card, dimmed && styles.cardDimmed]}>
      <View style={styles.headerRow}>
        <MaterialIcons name="compare-arrows" size={18} color={WARN} />
        <Text size="sm" bold style={styles.title}>
          {t('conflict.title')}
        </Text>
      </View>

      <View style={styles.statements}>
        <View style={styles.statementBlock}>
          <Text size="xs" bold style={styles.statementLabel}>
            {t('conflict.newLabel')}
          </Text>
          <Text size="sm" style={styles.statementText}>
            {conflict.newStatement}
          </Text>
        </View>
        <View style={styles.statementBlock}>
          <Text size="xs" bold style={styles.statementLabel}>
            {t('conflict.existingLabel')}
          </Text>
          <Text size="sm" style={styles.statementText}>
            {conflict.existingStatement}
          </Text>
        </View>
      </View>

      {resolved === null && !mergeOpen && (
        <View style={styles.verbs}>
          <VerbRow
            icon="library-add"
            label={t('conflict.keepBoth')}
            preview={t('conflict.keepBothPreview')}
            onPress={handleKeepBoth}
            disabled={busy}
          />
          <VerbRow
            icon="published-with-changes"
            label={t('conflict.replaceOld')}
            preview={t('conflict.replaceOldPreview', { statement: conflict.existingStatement })}
            onPress={handleReplace}
            disabled={busy}
          />
          <VerbRow
            icon="call-merge"
            label={t('conflict.merge')}
            preview={t('conflict.mergePreview', { statement: conflict.suggestedMerge })}
            onPress={() => {
              hapticLight();
              setMergeOpen(true);
            }}
            disabled={busy}
          />
          <VerbRow
            icon="close"
            label={t('conflict.dismiss')}
            preview={t('conflict.dismissPreview')}
            onPress={handleDismiss}
            disabled={busy}
          />
        </View>
      )}

      {resolved === null && mergeOpen && (
        <View style={styles.mergeBox}>
          <Text size="xs" bold style={styles.statementLabel}>
            {t('conflict.mergeEditLabel')}
          </Text>
          <TextInput
            value={mergeText}
            onChangeText={setMergeText}
            multiline
            style={styles.mergeInput}
            placeholder={t('conflict.mergePlaceholder')}
            placeholderTextColor="rgb(120, 120, 120)"
          />
          <View style={styles.mergeButtons}>
            <Pressable
              onPress={() => setMergeOpen(false)}
              disabled={busy}
              style={[styles.pill, styles.pillGhost]}
            >
              <Text size="xs" style={styles.pillGhostText}>
                {t('conflict.mergeCancel')}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleApplyMerge}
              disabled={busy || mergeText.trim().length === 0}
              style={[styles.pill, styles.pillPrimary]}
            >
              <Text size="xs" style={styles.pillPrimaryText}>
                {t('conflict.mergeApply')}
              </Text>
            </Pressable>
          </View>
        </View>
      )}

      {resolved !== null && (
        <View style={styles.statusRow}>
          <MaterialIcons name="check-circle" size={16} color={WARN} />
          <Text size="xs" style={styles.statusText}>
            {t(STATUS_LABEL_KEY[resolved])}
          </Text>
        </View>
      )}
    </Animated.View>
  );
};

interface VerbRowProps {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  preview: string;
  onPress: () => void;
  disabled?: boolean;
}

const VerbRow: React.FC<VerbRowProps> = ({ icon, label, preview, onPress, disabled }) => (
  <Pressable onPress={onPress} disabled={disabled} style={styles.verbRow}>
    <MaterialIcons name={icon} size={18} color={WARN} style={styles.verbIcon} />
    <View style={styles.verbBody}>
      <Text size="sm" bold style={styles.verbLabel}>
        {label}
      </Text>
      <Text size="xs" style={styles.verbPreview} numberOfLines={2}>
        {preview}
      </Text>
    </View>
  </Pressable>
);

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(233, 179, 83, 0.09)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: WARN,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  cardDimmed: { opacity: 0.6 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: WARN },
  statements: { gap: 8 },
  statementBlock: { gap: 2 },
  statementLabel: {
    color: 'rgb(180, 180, 180)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statementText: { color: 'rgb(215, 215, 215)' },
  verbs: { gap: 6 },
  verbRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 4 },
  verbIcon: { marginTop: 2 },
  verbBody: { flex: 1, gap: 1 },
  verbLabel: { color: WARN },
  verbPreview: { color: 'rgb(170, 170, 170)' },
  mergeBox: { gap: 8 },
  mergeInput: {
    minHeight: 56,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(233, 179, 83, 0.5)',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: 'rgb(225, 225, 225)',
    fontSize: 15,
    textAlignVertical: 'top',
  },
  mergeButtons: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  pill: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16 },
  pillGhost: { backgroundColor: 'rgba(255, 255, 255, 0.06)' },
  pillGhostText: { color: 'rgb(190, 190, 190)' },
  pillPrimary: { backgroundColor: WARN },
  pillPrimaryText: { color: 'rgb(20, 20, 20)', fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusText: { color: 'rgb(180, 180, 180)' },
});

export default ConflictResolutionCard;
