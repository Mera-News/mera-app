// OnboardingPathCard: the questionnaire's three options, drawn under its "what next" row.
// A check mark shows once the reader has done an option; every option stays tappable.

import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { GlyphSafeButton, TOUCH_FRAME } from '@/components/custom/floating-chat/glyph-safe';
import type { OnboardingPath } from '@/components/custom/floating-chat/types';
import { Text } from '@/components/ui/text';
import { observeFacts } from '@/lib/database/services/fact-service';
import { observeActive } from '@/lib/database/services/tracked-story-service';
import { hapticLight } from '@/lib/haptics';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

interface OnboardingPathCardProps {
  /** Then no fact is the first answer about where they live, so one fact counts. */
  declinedHome: boolean;
  aboutDone: boolean;
  onPick: (path: OnboardingPath) => void;
}

export default function OnboardingPathCard({ declinedHome, aboutDone, onPick }: OnboardingPathCardProps) {
  const styles = useStyles();
  const colors = useColors();
  const { t } = useTranslation();
  const [factCount, setFactCount] = useState(0);
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    const facts = observeFacts().subscribe((rows) => setFactCount(rows.length));
    const stories = observeActive().subscribe((rows) => setFollowing(rows.length > 0));
    return () => {
      facts.unsubscribe();
      stories.unsubscribe();
    };
  }, []);

  const options = [
    { path: 'profile', icon: 'person-outline', label: t('onboarding.pathProfile'), done: factCount > (declinedHome ? 0 : 1) },
    { path: 'follow', icon: 'sync', label: t('onboarding.pathFollow'), done: following },
    { path: 'about', icon: 'help-outline', label: t('onboarding.pathAbout'), done: aboutDone },
  ] as const;

  return (
    <View style={styles.card} testID="onboarding-path-card">
      {options.map(({ path, icon, label, done }, i) => (
        <GlyphSafeButton
          key={path}
          testID={`onboarding-path-${path}`}
          onPress={() => {
            hapticLight();
            onPick(path);
          }}
          accessibilityLabel={done ? t('onboarding.pathDoneA11y', { option: label }) : label}
          style={i > 0 ? styles.divided : undefined}
          visualStyle={styles.row}
        >
          <MaterialIcons {...DECORATIVE_ICON_A11Y} name={icon} size={20} color={colors.ink2} />
          <Text size="sm" style={styles.label}>
            {label}
          </Text>
          {done ? (
            <MaterialIcons
              {...DECORATIVE_ICON_A11Y}
              testID={`onboarding-path-${path}-done`}
              name="check"
              size={20}
              color={colors.positive}
            />
          ) : null}
        </GlyphSafeButton>
      ))}
    </View>
  );
}

const useStyles = themedStyles((c) =>
  StyleSheet.create({
    card: {
      marginTop: 8,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.panelBorder,
      backgroundColor: c.surface,
      overflow: 'hidden',
    },
    divided: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.panelBorder,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: TOUCH_FRAME,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    label: {
      flex: 1,
      color: c.ink,
      fontSize: 15,
      lineHeight: 21,
    },
  }),
);
