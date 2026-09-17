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

// THIS FILE IS THE ONE PLACE A STEP KEY BECOMES TEXT.
//
// Every key below is a LITERAL inside a `t()` call, so tsc checks it against
// the union generated from en.json: a key that never reached the dictionaries
// is a build error, not a raw dot-path rendered at a user. That is also why
// the key tables live here rather than in the pure label module — `t()`'s
// overloads pin the option shape per key, so a key held in a variable cannot
// be passed to it at all.

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

  /** Step labels with no interpolation. A key absent here renders the generic
   *  line, which is what keeps an unmapped tool from showing a dot-path. */
  const PLAIN_LABEL: Record<string, string> = {
    'agentSteps.legStart': t('agentSteps.legStart'),
    'agentSteps.loadSkillGeneric': t('agentSteps.loadSkillGeneric'),
    'agentSteps.findSimilarFacts': t('agentSteps.findSimilarFacts'),
    'agentSteps.writeUp': t('agentSteps.writeUp'),
    'agentSteps.removing': t('agentSteps.removing'),
    'agentSteps.asking': t('agentSteps.asking'),
    'agentSteps.working': t('agentSteps.working'),
  };

  const SKILL_PHRASE: Record<string, string> = {
    'skillPhrase.residence': t('skillPhrase.residence'),
    'skillPhrase.work': t('skillPhrase.work'),
    'skillPhrase.interests': t('skillPhrase.interests'),
    'skillPhrase.origin': t('skillPhrase.origin'),
    'skillPhrase.family': t('skillPhrase.family'),
    'skillPhrase.newFact': t('skillPhrase.newFact'),
    'skillPhrase.topics': t('skillPhrase.topics'),
  };

  const CONSEQUENCE: Record<string, string> = {
    'agentSteps.consequence.generic': t('agentSteps.consequence.generic'),
    'agentSteps.consequence.interrupted': t('agentSteps.consequence.interrupted'),
    'agentSteps.consequence.lookupPlace': t('agentSteps.consequence.lookupPlace'),
    'agentSteps.consequence.findSimilarFacts': t('agentSteps.consequence.findSimilarFacts'),
    'agentSteps.consequence.loadSkill': t('agentSteps.consequence.loadSkill'),
    'agentSteps.consequence.writeUp': t('agentSteps.consequence.writeUp'),
    'agentSteps.consequence.removing': t('agentSteps.consequence.removing'),
  };

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

  /** A step's label. The two interpolating keys are handled explicitly; every
   *  other key comes from the table, and an unknown one falls back rather than
   *  rendering its own name. */
  const labelFor = (step: AgentStep): string => {
    const values = step.labelValues;
    if (step.labelKey === 'agentSteps.loadSkill' && values?.topicKey) {
      const phrase = SKILL_PHRASE[values.topicKey];
      if (phrase) return t('agentSteps.loadSkill', { topic: phrase });
      return PLAIN_LABEL['agentSteps.loadSkillGeneric'];
    }
    if (step.labelKey === 'agentSteps.lookupPlace' && values?.query) {
      return t('agentSteps.lookupPlace', { query: values.query });
    }
    return PLAIN_LABEL[step.labelKey] ?? PLAIN_LABEL['agentSteps.working'];
  };

  const summary = legCapped
    ? t('agentSteps.legCapSentence')
    : interrupted
      ? t('agentSteps.interrupted')
      : failedCount > 0
        ? t('agentSteps.summaryFailed')
        : t('agentSteps.summaryDone');

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
            errorText={
              step.consequenceKey
                ? (CONSEQUENCE[step.consequenceKey] ??
                  CONSEQUENCE['agentSteps.consequence.generic'])
                : undefined
            }
            testID={`agent-step-${step.id}`}
          />
          {slow && step.id === pendingId && (
            <Text size="xs" style={styles.slow} testID="agent-steps-slow" numberOfLines={2}>
              {t('agentSteps.slow')}
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
