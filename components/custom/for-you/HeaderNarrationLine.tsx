// The rotating line that stands in for the screen title while a sync runs.
//
// The header's job during a run is to answer "why is this slow?" before the
// reader has to ask, and the honest answer is that the work is happening on
// their phone, right now, with their interests never leaving it. Half the
// pool says that. The other half points AWAY from the pipeline entirely —
// read something you saved, read one story properly — because the failure
// this replaces was not silence, it was arrival-anticipation.
//
// ## Presentational, and it owns only the clock
//
// Every decision about WHICH line to show is in
// `lib/services/header-narration.ts`, which is pure. This file owns the
// interval, the crossfade and the run bookkeeping ref, and nothing else.
//
// ## The crossfade uses ONE shared opacity
//
// Not a keyed `Animated.View` with `entering`/`exiting`. `ProcessingArea.tsx`
// and `ChatPhaseLine.tsx` both record why from experience: Reanimated keeps
// the exiting copy painted, outside the layout flow, while the new one mounts,
// which draws two sentences on top of each other. In a row whose height is
// PINNED that is not a transient glitch, it is two sentences overlapping with
// nowhere to go. Fade out, swap at the trough, fade in; exactly one line is
// mounted at any instant.
//
// ## Reduced motion keeps the TEXT rotating, and this diverges from the chat
//
// `ChatPhaseLine` stops rotating entirely under reduced motion, which is safe
// there because the phase keeps changing underneath, so a frozen pool still
// narrates. Here `analysing` can sit for a minute with NO TITLE ON SCREEN, so
// freezing would leave a title-less header showing one sentence for sixty
// seconds and never showing a single nudge. An instant text swap is not
// motion in the WCAG sense; the CROSSFADE is, and that is what stops. The
// hold lengthens, because a hard cut needs longer to read than a fade does.
//
// ## No live region, and this also diverges from the chat
//
// `ChatPhaseLine` is `accessibilityLiveRegion="polite"` because a chat wait is
// a focused wait on one element. Here the reader is working a list, and a
// region announcing a new sentence every four seconds would talk over them.
// One stable label for the whole line instead, which is what
// `HEADER_NARRATION_A11Y_KEY` is.

import { Text } from '@/components/ui/text';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import type { ProcessingStageId } from '@/lib/services/processing-stage';
import {
  advanceHeaderNarrationRun,
  resolveHeaderNarration,
  startHeaderNarrationRun,
  type HeaderNarrationRun,
} from '@/lib/services/header-narration';
import {
  HEADER_NARRATION_A11Y_KEY,
  HEADER_NARRATION_KEYS,
  HEADER_NARRATION_METRICS,
  NARRATION_CYCLE_MS,
  NARRATION_FADE_MS,
  NARRATION_HOLD_MS,
} from './header-narration';

/**
 * Extra dwell when the crossfade is off.
 *
 * A fade warns the eye that the sentence is about to change; a hard cut does
 * not, so under reduced motion the line has to sit longer to stay comfortably
 * readable. 1500ms against the 1000ms the crossfade would have occupied.
 */
export const REDUCED_MOTION_EXTRA_MS = 1500;

/** The full cycle with the crossfade off: still rotating, just slower. */
export const REDUCED_MOTION_CYCLE_MS = NARRATION_HOLD_MS + REDUCED_MOTION_EXTRA_MS;

export interface HeaderNarrationLineProps {
  /** The live pipeline stage, or null before one resolves. */
  readonly stage: ProcessingStageId | null;
  /** Scoring is running locally rather than in the cloud. */
  readonly onDevice: boolean;
  readonly testID?: string;
}

export const HeaderNarrationLine: React.FC<HeaderNarrationLineProps> = ({
  stage,
  onDevice,
  testID = 'header-narration-line',
}) => {
  const { t } = useTranslation();
  const tAny = t as unknown as (key: string, opts?: object) => string | string[];
  const reduceMotion = useReducedMotion();

  // The run's bookkeeping. A REF, not state: it never drives a render on its
  // own, the interval below is what does. Seeded once per mount, and a mount
  // IS a run — the parent renders this only while `isFeedProcessing`.
  //
  // The seed is random per run because the pool is six long and a run happens
  // many times a day: without it every run opens on the same nudge and a
  // reader sees one sentence far more than the other five.
  const runRef = useRef<HeaderNarrationRun | null>(null);
  if (runRef.current === null) {
    runRef.current = startHeaderNarrationRun(stage, onDevice, Math.floor(Math.random() * 6));
  }

  // Mirrors the ref so a swap actually repaints. `slot` is what the render
  // reads; the ref is what the interval advances.
  const [slot, setSlot] = useState<HeaderNarrationRun>(runRef.current);

  // The live stage, read by the interval at fire time rather than captured by
  // whichever render happened to schedule it. Without this the interval either
  // narrates a stale stage forever or has to be torn down and rebuilt on every
  // stage change, which restarts the hold and makes a fast run flicker.
  const inputRef = useRef({ stage, onDevice });
  inputRef.current = { stage, onDevice };

  const opacity = useSharedValue(1);
  const crossfades = !reduceMotion;
  const cycleMs = crossfades ? NARRATION_CYCLE_MS : REDUCED_MOTION_CYCLE_MS;

  useEffect(() => {
    let swap: ReturnType<typeof setTimeout> | undefined;

    const advance = () => {
      const next = advanceHeaderNarrationRun(
        runRef.current!,
        inputRef.current.stage,
        inputRef.current.onDevice,
      );
      runRef.current = next;
      setSlot(next);
    };

    const timer = setInterval(() => {
      if (!crossfades) {
        // Reduced motion: the text still rotates, the fade does not happen.
        advance();
        return;
      }
      opacity.value = withTiming(0, { duration: NARRATION_FADE_MS });
      swap = setTimeout(() => {
        advance();
        opacity.value = withTiming(1, { duration: NARRATION_FADE_MS });
      }, NARRATION_FADE_MS);
    }, cycleMs);

    // BOTH timers. Unmount here is the NORMAL end of a run, not an edge case:
    // it happens every time a sync finishes. A swap left armed repaints a line
    // into a header that has already gone back to showing its title.
    return () => {
      clearInterval(timer);
      if (swap) clearTimeout(swap);
    };
  }, [crossfades, cycleMs, opacity]);

  const narration = resolveHeaderNarration({
    tick: slot.tick,
    stageStartTick: slot.stageStartTick,
    stage,
    onDevice,
    nudgeSeed: slot.nudgeSeed,
  });

  const raw = tAny(HEADER_NARRATION_KEYS[narration.poolId], { returnObjects: true });
  const pool = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const lineStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // A pool that came back empty means a missing key, which the copy test makes
  // impossible in a shipped build. Rendering nothing beats rendering the key.
  if (pool.length === 0) return null;

  // The cursor is unbounded by design — the resolver holds no copy and cannot
  // know a pool's length, so the wrap happens here, where the length is known.
  const line = pool[narration.cursor % pool.length];

  return (
    <Animated.View style={lineStyle} pointerEvents="none">
      <Text
        style={styles.line}
        numberOfLines={HEADER_NARRATION_METRICS.maxLines}
        // ONE stable label for the line as a whole. Deliberately NOT the
        // sentence on screen and deliberately not a live region: see the
        // header comment.
        accessibilityRole="text"
        accessibilityLabel={t(HEADER_NARRATION_A11Y_KEY)}
        testID={testID}
      >
        {line}
      </Text>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  line: {
    color: 'rgb(190, 190, 190)',
    fontSize: HEADER_NARRATION_METRICS.fontSize,
    lineHeight: HEADER_NARRATION_METRICS.lineHeight,
  },
});

export default HeaderNarrationLine;
