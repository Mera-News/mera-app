// FactCard — presentational card summarizing a persona mutation (fact saved /
// deleted / config updated) produced by a tool call. No delete/undo behavior
// yet — display only.

import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, ButtonText } from '@/components/ui/button';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { FactCardAction, PendingDelete } from './types';

const ACCENT = 'rgb(231, 138, 83)';

// Fade + slide up with a slight scale-up (0.97 → 1). Custom entering builder so
// the scale rides the same ~280ms curve as the fade/slide (FadeInDown alone
// can't express scale).
function factCardEntering() {
  'worklet';
  const duration = 280;
  return {
    initialValues: {
      opacity: 0,
      transform: [{ translateY: 12 }, { scale: 0.97 }],
    },
    animations: {
      opacity: withTiming(1, { duration }),
      transform: [
        { translateY: withTiming(0, { duration }) },
        { scale: withTiming(1, { duration }) },
      ],
    },
  };
}

export interface FactCardProps {
  action: FactCardAction;
  statements: string[];
  /** A live pending removal: Remove and Keep act on exactly these facts. */
  pendingDelete?: PendingDelete;
}

const ICON_BY_ACTION: Record<FactCardAction, keyof typeof MaterialIcons.glyphMap> = {
  saved: 'check-circle',
  deleted: 'delete',
  deletePending: 'delete-outline',
  deleteKept: 'undo',
  updated: 'tune',
};

const TITLE_KEY_BY_ACTION = {
  saved: 'floatingChat.factSavedTitle',
  deleted: 'floatingChat.factDeletedTitle',
  deletePending: 'floatingChat.factDeletePendingTitle',
  deleteKept: 'floatingChat.factDeleteKept',
  updated: 'floatingChat.factUpdatedTitle',
} as const satisfies Record<FactCardAction, string>;

const FactCard: React.FC<FactCardProps> = ({ action, statements, pendingDelete }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const answer = (choice: 'remove' | 'keep') => async () => {
    if (!pendingDelete || busy) return;
    setBusy(true);
    try {
      // LAZY: the action reaches the database, which must stay out of every
      // suite that renders this card.
      const { confirmPendingDelete } =
        require('./fact-choice-actions') as typeof import('./fact-choice-actions');
      await confirmPendingDelete(pendingDelete, choice);
    } finally {
      setBusy(false);
    }
  };

  // Keep answered the card: one quiet line, nothing else.
  if (action === 'deleteKept') {
    return (
      <Text size="sm" style={styles.keptLine} testID="fact-delete-kept">
        {t(TITLE_KEY_BY_ACTION.deleteKept)}
      </Text>
    );
  }

  return (
    <Animated.View entering={factCardEntering} style={styles.card}>
      <View style={styles.headerRow}>
        <MaterialIcons {...DECORATIVE_ICON_A11Y} name={ICON_BY_ACTION[action]} size={18} color={ACCENT} />
        <Text size="sm" bold style={styles.title}>
          {t(TITLE_KEY_BY_ACTION[action])}
        </Text>
      </View>
      {statements.length > 0 && (
        <View style={styles.statements}>
          {statements.map((statement, idx) => (
            <View key={`${idx}-${statement}`} style={styles.statementRow}>
              <View style={styles.dot} />
              {/* Fact statements are English BY DESIGN — the agent's LANGUAGE
                  rule keeps them English even when it is talking Hindi — so
                  this card is where a Hindi reader would otherwise meet raw
                  English. Display only: the statement was already written to
                  the DB by the tool call that produced this card, and nothing
                  reads back from here. */}
              <TranslatableDynamic
                text={statement}
                size="sm"
                style={styles.statementText}
              />
            </View>
          ))}
        </View>
      )}
      {pendingDelete && (
        <View style={styles.buttonStack}>
          <Button
            testID="fact-delete-remove"
            onPress={answer('remove')}
            isDisabled={busy}
            className="rounded-full bg-transparent border border-error-400"
            size="sm"
            style={styles.tapTarget}
            accessibilityLabel={t('floatingChat.factDeleteRemove')}
          >
            <ButtonText className="text-sm" style={styles.removeText}>
              {t('floatingChat.factDeleteRemove')}
            </ButtonText>
          </Button>
          <Pressable
            testID="fact-delete-keep"
            onPress={answer('keep')}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy }}
            accessibilityLabel={t('floatingChat.factDeleteKeep')}
            style={styles.keepButton}
          >
            <Text size="sm" style={styles.keepText}>
              {t('floatingChat.factDeleteKeep')}
            </Text>
          </Pressable>
        </View>
      )}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(231, 138, 83, 0.08)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ACCENT,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: ACCENT,
  },
  statements: {
    gap: 4,
  },
  statementRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: ACCENT,
    marginTop: 8,
  },
  statementText: {
    flex: 1,
    color: 'rgb(193, 193, 193)',
  },
  buttonStack: { gap: 4, marginTop: 4 },
  tapTarget: { minHeight: 44 },
  removeText: { color: '#F87171' },
  keepButton: { minHeight: 44, alignSelf: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  keepText: { color: 'rgb(200, 200, 200)' },
  keptLine: { color: 'rgb(150, 150, 150)', paddingHorizontal: 4 },
});

export default FactCard;
