// FactCard — presentational card summarizing a persona mutation (fact saved /
// deleted / config updated) produced by a tool call. No delete/undo behavior
// yet — display only.

import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { FactCardAction } from './types';

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
}

const ICON_BY_ACTION: Record<FactCardAction, keyof typeof MaterialIcons.glyphMap> = {
  saved: 'check-circle',
  deleted: 'delete',
  updated: 'tune',
};

const TITLE_KEY_BY_ACTION = {
  saved: 'floatingChat.factSavedTitle',
  deleted: 'floatingChat.factDeletedTitle',
  updated: 'floatingChat.factUpdatedTitle',
} as const satisfies Record<FactCardAction, string>;

const FactCard: React.FC<FactCardProps> = ({ action, statements }) => {
  const { t } = useTranslation();

  return (
    <Animated.View entering={factCardEntering} style={styles.card}>
      <View style={styles.headerRow}>
        <MaterialIcons name={ICON_BY_ACTION[action]} size={18} color={ACCENT} />
        <Text size="sm" bold style={styles.title}>
          {t(TITLE_KEY_BY_ACTION[action])}
        </Text>
      </View>
      {statements.length > 0 && (
        <View style={styles.statements}>
          {statements.map((statement, idx) => (
            <View key={`${idx}-${statement}`} style={styles.statementRow}>
              <View style={styles.dot} />
              <Text size="sm" style={styles.statementText}>
                {statement}
              </Text>
            </View>
          ))}
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
});

export default FactCard;
