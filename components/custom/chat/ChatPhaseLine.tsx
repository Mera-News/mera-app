// The wait line inside the assistant bubble, replacing the rotating word.
//
// A word that changes says a person is being worked for. A SENTENCE that
// changes when the work changes says what is actually happening, which is the
// difference between a slow app and an app that is busy on your behalf. Every
// line here is true at the moment it is on screen: the phases come from real
// points in the request's lifecycle, never from a timer.
//
// ## Presentational, with ONE subscription
//
// It reads the phase store directly rather than taking a prop, so a phase tick
// re-renders this `<Text>` and not `ChatThread`, the item list or
// `ChatSessionView`. That matters on the one path this whole feature exists to
// make feel fast.
//
// ## The crossfade uses ONE shared opacity
//
// Not a keyed `Animated.View` with `entering`/`exiting`. `ProcessingArea` and
// `StreamingIndicator` both record why from experience: Reanimated keeps the
// exiting copy painted, outside the layout flow, while the new one mounts,
// which drew two captions on top of each other in a fixed-height row. Fade
// out, swap at the trough, fade in. Exactly one line is mounted at any instant.
//
// ## Two gates, and they are different questions
//
// `useReducedMotion()` is the accessibility setting: someone who asked for
// less motion did not mean "except in text", so the pool stops rotating. The
// phase itself still changes, because that is state, not decoration, and it is
// the same thing the steps box does when it adds a row.
//
// `useAnimationsActive()` is `focused && foregrounded`, NOT reduced motion,
// whatever the comment on the component this one replaces said. Its own
// docstring forbids using it to gate a liveness indicator, so it is not used
// here at all: a paused line on a backgrounded chat reads as a hung request.

import { Text } from '@/components/ui/text';
import React, { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useChatPhaseStore } from '@/lib/llm/chat-phase-store';
import { chatPhaseDef, FADE_MS, OPENING_PHASE_ID, PHASE_CYCLE_MS } from './chat-phases';

export interface ChatPhaseLineProps {
  testID?: string;
}

export const ChatPhaseLine: React.FC<ChatPhaseLineProps> = ({ testID = 'chat-phase-line' }) => {
  const { t } = useTranslation();
  const tAny = t as unknown as (key: string, opts?: object) => string | string[];
  const view = useChatPhaseStore((s) => s.view);
  const reduceMotion = useReducedMotion();

  // THE THREE-STATE READ, and the two "no phase" cases are opposites.
  //
  //  - `released`: a turn published and handed over, because real text arrived
  //    or the turn died. Render NOTHING. Falling back here flashes the opening
  //    sentence for a frame at the handover, which is a backwards walk at the
  //    exact moment the reader's eye is on the bubble.
  //  - `idle`: nothing published yet. Render the OPENING pool, so a caller
  //    that forgets to publish degrades to a sentence rather than to an empty
  //    assistant bubble.
  const phaseId = view.kind === 'phase' ? view.id : view.kind === 'idle' ? OPENING_PHASE_ID : null;
  const phrasesKey = phaseId ? chatPhaseDef(phaseId).phrasesKey : null;

  const raw = phrasesKey ? tAny(phrasesKey, { returnObjects: true }) : undefined;
  const lines = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const [index, setIndex] = useState(0);
  const opacity = useSharedValue(1);
  const rotates = !reduceMotion && lines.length > 1 && phrasesKey !== null;

  // Reset on a phase change so a new pool never opens mid-rotation on an index
  // that belongs to the pool before it.
  useEffect(() => {
    setIndex(0);
    opacity.value = 1;
  }, [phrasesKey, opacity]);

  useEffect(() => {
    if (!rotates) return;
    let swap: ReturnType<typeof setTimeout> | undefined;
    const timer = setInterval(() => {
      opacity.value = withTiming(0, { duration: FADE_MS });
      swap = setTimeout(() => {
        setIndex((i) => (i + 1) % lines.length);
        opacity.value = withTiming(1, { duration: FADE_MS });
      }, FADE_MS);
    }, PHASE_CYCLE_MS);
    // BOTH timers, on unmount and on every phase change. A swap left armed
    // repaints a line after the bubble has gone, which is the same class of
    // bug the streaming render queue's `armed` latch exists for.
    return () => {
      clearInterval(timer);
      if (swap) clearTimeout(swap);
    };
  }, [rotates, lines.length, opacity]);

  const lineStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (!phrasesKey || lines.length === 0) return null;

  const line = lines[index] ?? lines[0];

  return (
    <Animated.View style={lineStyle}>
      <Text
        size="sm"
        style={styles.line}
        // ONE polite live region. The mark beside it is decorative, so the
        // wait is announced once rather than twice.
        accessibilityLiveRegion="polite"
        accessibilityRole="text"
        accessibilityLabel={line}
        testID={testID}
      >
        {line}
      </Text>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  line: { color: 'rgb(190, 190, 190)', fontSize: 15, lineHeight: 21 },
});

export default ChatPhaseLine;
