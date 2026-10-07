// AgentStepsBox — what Mera is doing, for one turn.
//
// Presentational: every decision about WHICH steps exist, whether the box is
// collapsed, and whether the turn was interrupted is made in deriveThreadItems.
// This file renders that and owns exactly one piece of state of its own: the
// "still working" line that appears when a step has been pending a while.

import StatusIndicator from '@/components/custom/chat/StatusIndicator';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { Text } from '@/components/ui/text';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, withTiming } from 'react-native-reanimated';
import { GlyphSafeButton } from './glyph-safe';
import { useTranslation } from 'react-i18next';
import type { AgentStep, AgentTerminal } from './types';

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

/** A new step slides up 8pt and fades in (FinalMeraChat #7). */
function stepEntering() {
  'worklet';
  const duration = 180;
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 8 }] },
    animations: {
      opacity: withTiming(1, { duration }),
      transform: [{ translateY: withTiming(0, { duration }) }],
    },
  };
}

/** A finished step behind the live one. */
const DONE_DIM = 0.6;
/** The fold opening again on a tap. */
const REOPEN_MS = 220;

export interface AgentStepsBoxProps {
  steps: AgentStep[];
  collapsed: boolean;
  doneCount: number;
  failedCount: number;
  terminal: AgentTerminal | null;
  interrupted: boolean;
}

export /** The first line of a phrase pool, or the value itself when it is a string. */
function firstLine(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
  return typeof value === 'string' ? value : '';
}

const AgentStepsBox: React.FC<AgentStepsBoxProps> = ({
  steps,
  collapsed,
  doneCount,
  failedCount,
  terminal,
  interrupted,
}) => {
  const styles = useStyles();
  const { t } = useTranslation();
  const colors = useColors();
  // A folded box opens again on a tap (FinalMeraChat #9). Local: it is a view
  // of a finished turn, nothing about the turn changes.
  const [reopened, setReopened] = useState(false);

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
    // The wait line's own copy, so the box says the same thing the line
    // would (ux2 batch 25, D6). A pool: its first line.
    'chatPhases.webSearch': firstLine(t('chatPhases.webSearch', { returnObjects: true })),
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

  // ONE sentence per terminal, and the terminal outranks the step tally: a turn
  // whose every step succeeded and which then routed nothing is a failure the
  // step rows cannot show. `settled` and `awaiting-user` never reach here.
  // `as const` is load-bearing: the i18n key type is a literal union, and a
  // widened `string` fails the call rather than resolving at run time.
  const TERMINAL_KEY = {
    'leg-cap': 'agentSteps.legCapSentence',
    'no-route': 'agentSteps.noRouteSentence',
    'no-proposal': 'agentSteps.noProposalSentence',
    'unknown-tool': 'agentSteps.unknownToolSentence',
    'malformed-choice': 'agentSteps.malformedChoiceSentence',
  } as const satisfies Record<AgentTerminal, string>;
  const summary = terminal
    ? t(TERMINAL_KEY[terminal])
    : interrupted
      ? t('agentSteps.interrupted')
      : failedCount > 0
        ? t('agentSteps.summaryFailed')
        : t('agentSteps.doneInSteps', { count: doneCount });
  // The fold is a button, so a finished turn's label says what a tap does.
  // One plural key (not a comma join) so every locale words it whole. A
  // failed, interrupted or terminal turn keeps its sentence as the label.
  const finished = !terminal && !interrupted && failedCount === 0;
  const foldLabel = finished ? t('agentSteps.doneInStepsShow', { count: doneCount }) : summary;
  // `no-proposal` is the one terminal that is not an error: Mera understood the
  // turn and had nothing to add, which is a normal answer.
  const terminalIsError = terminal !== null && terminal !== 'no-proposal';

  const live = !collapsed;
  const fold = (
    <GlyphSafeButton
      onPress={() => setReopened((v) => !v)}
      accessibilityLabel={foldLabel}
      accessibilityState={{ expanded: reopened }}
      visualStyle={styles.foldRow}
      testID="agent-steps-summary"
    >
      <View style={styles.foldStatus}>
        <StatusIndicator status={failedCount > 0 || interrupted || terminalIsError ? 'error' : 'done'} label={summary} />
      </View>
      <MaterialIcons
        {...DECORATIVE_ICON_A11Y}
        name={reopened ? 'expand-less' : 'expand-more'}
        size={18}
        color={colors.ink3}
      />
    </GlyphSafeButton>
  );

  const stepRows = (
    <>
      {live && (
        <Text size="xs" style={[styles.title, { color: colors.ink3 }]} testID="agent-steps-title">
          {t('agentSteps.boxTitle')}
        </Text>
      )}
      {steps.map((step) => (
        <Animated.View
          key={step.id}
          entering={live && animationsActive ? stepEntering : undefined}
          style={live && step.status === 'done' && step.id !== steps[steps.length - 1]?.id ? styles.dim : undefined}
        >
          <StatusIndicator
            live={live}
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
        </Animated.View>
      ))}
      {/* An interrupted or capped turn states it even while expanded: the
          terminal sentence is the part that tells the user what to do next. */}
      {(interrupted || terminal !== null) && (
        <Text size="xs" style={styles.terminal} numberOfLines={3} testID="agent-steps-terminal">
          {summary}
        </Text>
      )}
    </>
  );

  const body = collapsed ? (
    <>
      {fold}
      {reopened && (
        <Animated.View entering={animationsActive ? FadeIn.duration(REOPEN_MS) : undefined}>
          {stepRows}
        </Animated.View>
      )}
    </>
  ) : (
    stepRows
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

const useStyles = themedStyles((c) => StyleSheet.create({
  box: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.line,
    backgroundColor: c.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
  },
  slow: { color: c.ink3, marginLeft: 24, marginTop: 1 },
  title: { marginBottom: 4 },
  dim: { opacity: DONE_DIM },
  foldRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  foldStatus: { flex: 1 },
  terminal: { color: c.ink2, marginTop: 4 },
}));

export default AgentStepsBox;
