// AgentStepsBox — what Mera is doing, for one turn.
//
// Presentational: every decision about WHICH steps exist, whether the box is
// collapsed, and whether the turn was interrupted is made in deriveThreadItems.
// It owns three pieces of view state: which rows are landing (glyph, then the
// tick draws), the `return` it plays before folding, and the reopened fold.
//
// ONE SLOT PER TURN. The box takes the wait row's place: its fixed 32pt header
// holds the encryption strip while the turn runs and the "Done in N steps"
// fold once it settled. No title, no slide-in. ONE MOVING THING: while a row's
// glyph loops (a tool runs on the phone) or rows land, the strip rests.

import EncryptionStrip from '@/components/custom/chat/EncryptionStrip';
import StatusIndicator from '@/components/custom/chat/StatusIndicator';
import StepGlyph from '@/components/custom/chat/StepGlyph';
import { useAnnounce } from '@/components/custom/chat/phase-announcer';
import { STRIP_HEIGHT } from '@/components/custom/chat/chat-phases';
import { stripRests } from '@/components/custom/chat/strip-display';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { Text } from '@/components/ui/text';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { useMotionAllowed } from '@/lib/motion-gate';
import { themedStyles, useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { GlyphSafeButton } from './glyph-safe';
import { stepLabel, stepTables } from './agent-step-labels';
import { landingPlan } from './landing';
import { useTranslation } from 'react-i18next';
import type { AgentStep, AgentTerminal } from './types';

/** A finished step behind the live one. */
const DONE_DIM = 0.6;
/** The fold opening again on a tap. */
const REOPEN_MS = 220;
/** The fold row's touch frame grows past its 32pt slot without moving it. */
const FOLD_HIT_SLOP = Platform.OS === 'ios' ? 6 : 8;
/** If the strip never reports its `return` finished, fold anyway. */
const FOLD_FALLBACK_MS = 1500;

// ponytail: one short id per landed row for the session. A row lands once,
// ever: the chat view unmounts on close, and a reopened chat, a recycled row
// or a reopened fold must show ticks only.
const landedIds = new Set<string>();

export interface AgentStepsBoxProps {
  steps: AgentStep[];
  collapsed: boolean;
  doneCount: number;
  failedCount: number;
  terminal: AgentTerminal | null;
  interrupted: boolean;
  /** The turn ended normally, so an answer was decrypted: play `return`. */
  answered: boolean;
}

const AgentStepsBox: React.FC<AgentStepsBoxProps> = ({
  steps,
  collapsed,
  doneCount,
  failedCount,
  terminal,
  interrupted,
  answered,
}) => {
  const styles = useStyles();
  const { t } = useTranslation();
  const colors = useColors();
  const motion = useMotionAllowed();
  const liveTool = useChatPhaseStore((s) => s.liveTool);
  // A folded box opens again on a tap (FinalMeraChat #9). Local: it is a view
  // of a finished turn, nothing about the turn changes.
  const [reopened, setReopened] = useState(false);

  const { PLAIN_LABEL, SKILL_PHRASE, CONSEQUENCE } = useMemo(() => stepTables(t), [t]);
  const labelFor = (step: AgentStep): string => stepLabel(step, t, { PLAIN_LABEL, SKILL_PHRASE });

  // ── Landings ──────────────────────────────────────────────────────────────
  // A box that mounts folded is history: its rows count as landed already.
  const baselined = useRef(false);
  if (!baselined.current) {
    baselined.current = true;
    if (collapsed) for (const s of steps) landedIds.add(s.id);
  }
  const [landing, setLanding] = useState<ReadonlyMap<string, number>>(new Map());
  // A ref, not the effect's cleanup: `steps` is a new array on every derive,
  // and a cleanup would cancel the end of a landing that is still running.
  const landTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (landTimer.current) clearTimeout(landTimer.current);
  }, []);
  useEffect(() => {
    const plan = landingPlan(landedIds, steps);
    for (const id of plan.delays.keys()) landedIds.add(id);
    if (!motion || plan.totalMs === 0) return;
    // A newer batch cuts in; the rows still landing show their tick.
    if (landTimer.current) clearTimeout(landTimer.current);
    setLanding(plan.delays);
    landTimer.current = setTimeout(() => setLanding(new Map()), plan.totalMs);
  }, [steps, motion]);

  // ── The return before the fold ────────────────────────────────────────────
  // When the turn settles with an answer, the header plays `return` once and
  // only then becomes the fold. Never on a stop, an error or a terminal.
  const [folding, setFolding] = useState(false);
  const [returnRequest, setReturnRequest] = useState(0);
  // Decided DURING render (React's derived-state pattern), not in an effect:
  // an effect would commit one frame of the fold, unmount the strip and lose
  // the request.
  const [prevCollapsed, setPrevCollapsed] = useState(collapsed);
  if (collapsed !== prevCollapsed) {
    setPrevCollapsed(collapsed);
    if (collapsed && answered && motion) {
      setFolding(true);
      setReturnRequest((n) => n + 1);
    }
  }
  useEffect(() => {
    if (!folding) return;
    const fallback = setTimeout(() => setFolding(false), FOLD_FALLBACK_MS);
    return () => clearTimeout(fallback);
  }, [folding]);

  const live = !collapsed || folding;
  const rest = stripRests({ liveTool: liveTool !== null, landing: landing.size > 0, ackStreaming: false });

  // ── Speech ────────────────────────────────────────────────────────────────
  // No live region on the box: the running row's words go through the one
  // announcer, and one hidden status node carries them for a focused reader.
  const running = live ? steps.find((s) => s.status === 'pending') : undefined;
  const runningText = running ? `${labelFor(running)}, ${t('agentSteps.statePending')}` : null;
  useAnnounce(running ? labelFor(running) : null);

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
  } as const satisfies Record<Exclude<AgentTerminal, 'turn-failed'>, string>;
  // chat.turnFailed is spliced into the dictionaries later: cast until it is typed.
  const summary = terminal === 'turn-failed'
    ? (t as unknown as (key: string) => string)('chat.turnFailed')
    : terminal
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

  const header = live ? (
    <View style={styles.header}>
      <EncryptionStrip
        host="box"
        rest={rest}
        playReturn={returnRequest}
        onReturnDone={() => setFolding(false)}
      />
    </View>
  ) : (
    <GlyphSafeButton
      onPress={() => setReopened((v) => !v)}
      accessibilityLabel={foldLabel}
      accessibilityState={{ expanded: reopened }}
      hitSlop={{ top: FOLD_HIT_SLOP, bottom: FOLD_HIT_SLOP }}
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
      {steps.map((step) => (
        <View
          key={step.id}
          style={live && step.status === 'done' && step.id !== steps[steps.length - 1]?.id ? styles.dim : undefined}
        >
          <StatusIndicator
            status={step.status}
            label={labelFor(step)}
            glyph={
              step.status === 'error' ? undefined : (
                <StepGlyph
                  kind={step.glyph}
                  state={step.status === 'pending' ? 'pending' : landing.has(step.id) ? 'landing' : 'done'}
                  delayMs={landing.get(step.id) ?? 0}
                />
              )
            }
            errorText={
              step.consequenceKey
                ? (CONSEQUENCE[step.consequenceKey] ??
                  CONSEQUENCE['agentSteps.consequence.generic'])
                : undefined
            }
            testID={`agent-step-${step.id}`}
          />
        </View>
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

  return (
    <View style={styles.box} accessible={false} testID="agent-steps">
      {runningText !== null && (
        <View
          accessible
          accessibilityLabel={runningText}
          style={styles.statusNode}
          testID="agent-steps-status"
        />
      )}
      {header}
      {live ? (
        stepRows
      ) : reopened ? (
        // Reanimated's own gate: Lite lands this at once.
        <Animated.View entering={FadeIn.duration(REOPEN_MS)}>{stepRows}</Animated.View>
      ) : null}
    </View>
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
  // The strip's slot and the fold's: the same 32pt, so settling swaps one for
  // the other in place.
  header: { height: STRIP_HEIGHT, justifyContent: 'center' },
  // A hidden status node still needs a frame: VoiceOver skips a 0x0 element.
  statusNode: { position: 'absolute', width: 1, height: 1, overflow: 'hidden' },
  dim: { opacity: DONE_DIM },
  foldRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: STRIP_HEIGHT },
  foldStatus: { flex: 1 },
  terminal: { color: c.ink2, marginTop: 4 },
}));

export default AgentStepsBox;
