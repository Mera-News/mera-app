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

import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';
const FAILED = '#F87171';
const BODY = 'rgb(200, 200, 200)';

// PENDING SPLICE: these keys land with lib/locales/_pagent-fragments.json.
// `t()`'s overloads are generated from en.json, so until the splice they are
// not in the union. DELETE `PendingKey` and every `k(...)` in the same commit
// as the splice — tsc then proves the keys are really there, which eyeballing
// a dictionary cannot. Leaving it behind silences exactly that check.
type PendingKey = 'floatingChat.thinking';
const k = (key: string) => key as PendingKey;

export type IndicatorStatus = 'pending' | 'done' | 'error';

export interface StatusIndicatorProps {
  status: IndicatorStatus;
  /** Already localised. */
  label?: string;
  /** Already localised consequence text. NEVER a raw error or an Error. */
  errorText?: string;
  size?: 'sm' | 'md';
  testID?: string;
}

const STATE_KEY: Record<IndicatorStatus, string> = {
  pending: 'agentSteps.statePending',
  done: 'agentSteps.stateDone',
  error: 'agentSteps.stateError',
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  label,
  errorText,
  size = 'sm',
  testID,
}) => {
  const { t } = useTranslation();
  const glyph = size === 'md' ? 18 : 16;

  // An error always says something. Callers that forget still cannot ship a
  // blank failure.
  const failureLine =
    status === 'error' ? (errorText ?? t(k('agentSteps.consequence.generic'))) : undefined;

  const stateWord = t(k(STATE_KEY[status]));
  const a11y = label ? `${label}, ${stateWord}` : stateWord;

  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={failureLine ? `${a11y}. ${failureLine}` : a11y}
      testID={testID}
    >
      <View style={[styles.glyph, { width: glyph, height: glyph }]}>
        {status === 'pending' ? (
          <ActivityIndicator size="small" color={ACCENT} testID={testID && `${testID}-spinner`} />
        ) : (
          <MaterialIcons
            name={status === 'done' ? 'check' : 'block'}
            size={glyph}
            color={status === 'done' ? ACCENT : FAILED}
            testID={testID && `${testID}-${status}`}
          />
        )}
      </View>

      <View style={styles.body}>
        {label !== undefined && (
          // Two lines, tail-truncated. German and Dutch run long and a
          // mid-word cut is worse than a wrap.
          <Text size={size === 'md' ? 'sm' : 'xs'} style={styles.label} numberOfLines={2}>
            {label}
          </Text>
        )}
        {failureLine !== undefined && (
          <Text
            size="xs"
            style={styles.failure}
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
  label: { color: BODY },
  // Dimmer than the label but still above the 4.5:1 floor on this ground.
  failure: { color: 'rgb(176, 176, 176)' },
});

export default StatusIndicator;
