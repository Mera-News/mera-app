// AgentStepsBox — what Mera is doing, for one turn.
//
// Presentational: every decision about WHICH steps exist, whether the box is
// collapsed, and whether the turn was interrupted is made in deriveThreadItems.
// This file renders that and owns exactly one piece of state of its own: the
// "still working" line that appears when a step has been pending a while.

import StatusIndicator from '@/components/custom/chat/StatusIndicator';
import { Text } from '@/components/ui/text';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { withTiming } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { AgentStep } from './types';

/**
 * How long one step may sit pending before the box says so.
 *
 * Purely additive: it never changes a status, never retries, and never turns
 * into an error. A slow connection is not a failure, and saying "still working"
 * is the difference between a wait that reads as progress and one that reads as
 * a hang.
 */
export const SLOW_STEP_MS = 8_000;

// PENDING SPLICE: every agentSteps.* / skillPhrase.* key below lands with
// lib/locales/_pagent-fragments.json.
//
// `t()`'s overloads are generated from en.json and pin the OPTION SHAPE per
// key, so a key-cast cannot carry interpolation — hence one narrow cast of the
// function itself rather than a cast at each call. DELETE `tx` and use `t`
// directly in the same commit as the splice: tsc then checks every key AND
// every variable name against the generated union, which is the check this
// stands in for. Leaving it behind silences exactly that check.

function boxEntering() {
  'worklet';
  const duration = 240;
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 8 }] },
    animations: {
      opacity: withTiming(1, { duration }),
      transform: [{ translateY: withTiming(0, { duration }) }],
    },
  };
}

export interface AgentStepsBoxProps {
  steps: AgentStep[];
  collapsed: boolean;
  doneCount: number;
  failedCount: number;
  legCapped: boolean;
  interrupted: boolean;
}

export const AgentStepsBox: React.FC<AgentStepsBoxProps> = ({
  steps,
  collapsed,
  doneCount,
  failedCount,
  legCapped,
  interrupted,
}) => {
  const { t } = useTranslation();
  const tx = t as unknown as (key: string, options?: Record<string, unknown>) => string;

  // Gates the one-shot COLLAPSE/entry transition only. Deliberately not the
  // pending spinner: `use-is-focused-safe`'s own docstring says this hook must
  // not gate a liveness signal for an in-flight operation, because a paused one
  // reads as a hung request. A transition is not a liveness signal.
  const animationsActive = useAnimationsActive();

  const firstPending = steps.find((s) => s.status === 'pending');
  const pendingId = firstPending?.id ?? null;
  const [slow, setSlow] = useState(false);

  // Keyed on WHICH step is pending, so the clock restarts per step rather than
  // carrying a stale "slow" over to the next one.
  const lastPendingId = useRef<string | null>(null);
  useEffect(() => {
    if (lastPendingId.current !== pendingId) {
      lastPendingId.current = pendingId;
      setSlow(false);
    }
    if (pendingId === null) return;
    const timer = setTimeout(() => setSlow(true), SLOW_STEP_MS);
    return () => clearTimeout(timer);
  }, [pendingId]);

  /** A step's label, resolving the nested skill phrase when there is one. */
  const labelFor = (step: AgentStep): string => {
    const values = step.labelValues;
    if (values?.topicKey) {
      return tx(step.labelKey, { topic: tx(values.topicKey) });
    }
    return values ? tx(step.labelKey, values) : tx(step.labelKey);
  };

  const summary = legCapped
    ? tx('agentSteps.legCapSentence')
    : interrupted
      ? tx('agentSteps.interrupted')
      : failedCount > 0
        ? tx('agentSteps.summaryOneFailed', { count: failedCount })
        : tx('agentSteps.summaryDone', { count: doneCount });

  const body = collapsed ? (
    <StatusIndicator
      status={failedCount > 0 || interrupted || legCapped ? 'error' : 'done'}
      label={summary}
      testID="agent-steps-summary"
    />
  ) : (
    <>
      {steps.map((step) => (
        <View key={step.id}>
          <StatusIndicator
            status={step.status}
            label={labelFor(step)}
            errorText={step.consequenceKey ? tx(step.consequenceKey) : undefined}
            testID={`agent-step-${step.id}`}
          />
          {slow && step.id === pendingId && (
            <Text size="xs" style={styles.slow} testID="agent-steps-slow" numberOfLines={2}>
              {tx('agentSteps.slow')}
            </Text>
          )}
        </View>
      ))}
      {/* An interrupted or capped turn states it even while expanded: the
          terminal sentence is the part that tells the user what to do next. */}
      {(interrupted || legCapped) && (
        <Text size="xs" style={styles.terminal} numberOfLines={3} testID="agent-steps-terminal">
          {summary}
        </Text>
      )}
    </>
  );

  return (
    <Animated.View
      entering={animationsActive ? boxEntering : undefined}
      style={styles.box}
      accessible={false}
      accessibilityLiveRegion="polite"
      testID="agent-steps"
    >
      {body}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  box: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
  },
  slow: { color: 'rgb(150, 150, 150)', marginLeft: 24, marginTop: 1 },
  terminal: { color: 'rgb(176, 176, 176)', marginTop: 4 },
});

export default AgentStepsBox;
