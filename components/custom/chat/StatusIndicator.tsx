// StatusIndicator — the ONE way a Mera surface says pending / done / failed.
//
// Shared deliberately: the chat steps box and the persona facts row both show
// the same three states, and two implementations drift into two vocabularies
// for one idea. Consumers: components/custom/floating-chat/AgentStepsBox.tsx
// and the facts row (P4).
//
// IT TAKES LOCALISED STRINGS, NEVER AN ERROR OBJECT. That is the structural
// reason a raw provider error cannot reach the screen through this component:
// there is no parameter to pass one to. A provider's English JSON has been
// rendered verbatim to users in every locale once already, and the fix that
// lasts is a type that cannot express the mistake. When `status` is 'error'
// and no `errorText` is given it falls back to a generic localised line, so
// the failure is always in WORDS and never colour or a glyph alone.

import MeraLogo from '@/components/custom/MeraLogo';
import { Text } from '@/components/ui/text';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';


export type IndicatorStatus = 'pending' | 'done' | 'error';

export interface StatusIndicatorProps {
  status: IndicatorStatus;
  /** Already localised. */
  label?: string;
  /** Already localised consequence text. NEVER a raw error or an Error. */
  errorText?: string;
  size?: 'sm' | 'md';
  /** Pending shows the moving Mera mark instead of a spinner, and a step
   *  that turns done draws its tick in (the chat's steps, FinalMeraChat #7).
   *  Off: the plain spinner and a still tick (the facts row). */
  live?: boolean;
  testID?: string;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  label,
  errorText,
  size = 'sm',
  live = false,
  testID,
}) => {
  const { t } = useTranslation();
  const colors = useColors();
  const glyph = size === 'md' ? 18 : 16;

  // Literal keys, so tsc checks each one against the union generated from
  // en.json. A key that never reached the dictionaries is a build error here
  // rather than a dot-path read out to a screen-reader user.
  const stateWord =
    status === 'pending'
      ? t('agentSteps.statePending')
      : status === 'done'
        ? t('agentSteps.stateDone')
        : t('agentSteps.stateError');

  // An error always says something. Callers that forget still cannot ship a
  // blank failure.
  const failureLine =
    status === 'error' ? (errorText ?? t('agentSteps.consequence.generic')) : undefined;

  const a11y = label ? `${label}, ${stateWord}` : stateWord;

  return (
    // The WORDS are the accessible element and the glyph sits beside them,
    // hidden (ux2 batch 26): on iOS a glyph under ANY accessible ancestor
    // surfaces as its own StaticText, hidden props and all.
    <View style={styles.row}>
      <View style={[styles.glyph, { width: glyph, height: glyph }]}>
        {status === 'pending' && live ? (
          <MeraLogo size={glyph} color={colors.ink} animated showsProgress />
        ) : status === 'pending' ? (
          // Not an element of its own: the state word is in the label beside it.
          <ActivityIndicator
            size="small"
            color={colors.accentMark}
            accessible={false}
            testID={testID && `${testID}-spinner`}
          />
        ) : (
          <Animated.View entering={live ? ZoomIn.duration(180) : undefined}>
            <MaterialIcons
              {...DECORATIVE_ICON_A11Y}
              name={status === 'done' ? 'check' : 'block'}
              size={glyph}
              color={status === 'done' ? colors.accentMark : colors.negative}
              testID={testID && `${testID}-${status}`}
            />
          </Animated.View>
        )}
      </View>

      <View
        style={styles.body}
        accessible
        accessibilityLabel={failureLine ? `${a11y}. ${failureLine}` : a11y}
        testID={testID}
      >
        {label !== undefined && (
          // Two lines, tail-truncated. German and Dutch run long and a
          // mid-word cut is worse than a wrap.
          <Text size={size === 'md' ? 'sm' : 'xs'} style={{ color: colors.ink }} numberOfLines={2}>
            {label}
          </Text>
        )}
        {failureLine !== undefined && (
          <Text
            size="xs"
            style={{ color: colors.ink2 }}
            numberOfLines={2}
            testID={testID && `${testID}-consequence`}
          >
            {failureLine}
          </Text>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 3 },
  glyph: { alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  body: { flex: 1, gap: 1 },
});

export default StatusIndicator;
