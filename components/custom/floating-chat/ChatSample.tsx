// The faint example behind a fresh chat (owner design): a label and a few
// lines that change every few seconds, each line wiping in left to right while
// the old one wipes out along the same edge. Not a control: it takes no touch,
// and ChatSessionView unmounts it on the first touch anywhere in the chat.
// The wipe is a sliding clip, not a soft mask: a mask needs a native module.

import { useMotionAllowed } from '@/lib/motion-gate';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useColors } from '@/lib/theme/tokens';
import { translateText } from '@/lib/translation-service';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { sampleLines, type ChatSampleKind } from './chat-samples';

const HOLD_MS = 4500;
const WIPE_MS = 750;
const STAGGER_MS = 110;

/** English lines as-is; otherwise every line translated, or null when any failed. */
async function inAppLanguage(lines: string[], lang: string): Promise<string[] | null> {
  if (lang === 'en') return lines;
  const out = await Promise.all(lines.map((l) => translateText(l, lang, { priority: 50 })));
  return out.every((l): l is string => !!l) ? out : null;
}

export default function ChatSample({ kind }: { kind: ChatSampleKind }) {
  const { t } = useTranslation();
  const colors = useColors();
  const motion = useMotionAllowed();
  const lang = useAppLanguageStore((s) => s.appLanguage);
  const [shown, setShown] = useState<{ cur: string[]; prev: string[]; gen: number } | null>(null);
  const seed = useRef(0);

  // Ready the next set, then swap it in. A set waits until EVERY line is in the
  // app language (owner): the current one stays up meanwhile, and a set whose
  // translation fails is skipped for the next seed.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A different first sample each open.
    if (seed.current === 0) seed.current = Date.now() % 100000;
    const next = async (delay: number) => {
      timer = setTimeout(async () => {
        seed.current += 97;
        const lines = await inAppLanguage(sampleLines(kind, seed.current), lang);
        if (!alive) return;
        if (lines) setShown((s) => ({ cur: lines, prev: s?.cur ?? [], gen: (s?.gen ?? 0) + 1 }));
        next(lines ? HOLD_MS : 0);
      }, delay);
    };
    next(0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [kind, lang]);

  if (!shown) return null;
  const label = t(kind === 'profile' ? 'chatSample.profileLabel' : 'chatSample.storiesLabel');
  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityLabel={`${label}. ${shown.cur.join('. ')}`}
      style={styles.wrap}
      testID="chat-sample"
    >
      <Text style={[styles.label, { color: colors.ink3 }]}>{label}</Text>
      {shown.cur.map((line, i) => (
        <WipeRow
          key={i}
          text={line}
          prev={shown.prev[i] ?? ''}
          gen={shown.gen}
          delay={i * STAGGER_MS}
          motion={motion}
          color={colors.ink2}
        />
      ))}
    </View>
  );
}

function WipeRow(props: { text: string; prev: string; gen: number; delay: number; motion: boolean; color: string }) {
  const { text, prev, gen, delay, motion, color } = props;
  const [width, setWidth] = useState(0);
  const progress = useSharedValue(1);

  useEffect(() => {
    if (!motion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withDelay(delay, withTiming(1, { duration: WIPE_MS, easing: Easing.bezier(0.33, 0, 0.2, 1) }));
  }, [gen, delay, motion, progress]);

  const line = [styles.line, { color }];
  return (
    <View style={styles.row} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {/* Sizes the row: the clips below are absolute. */}
      <Text style={[line, styles.spacer]} numberOfLines={1}>
        {text.length >= prev.length ? text : prev}
      </Text>
      {width > 0 && (
        <>
          <Clip progress={progress} width={width} side="out" text={prev} style={line} />
          <Clip progress={progress} width={width} side="in" text={text} style={line} />
        </>
      )}
    </View>
  );
}

function Clip(props: {
  progress: SharedValue<number>;
  width: number;
  side: 'in' | 'out';
  text: string;
  style: object[];
}) {
  const { progress, width, side, text, style } = props;
  // "in" grows from the left edge; "out" shrinks toward the right edge, so both
  // share one edge moving left to right.
  const clip = useAnimatedStyle(() => ({
    width: (side === 'in' ? progress.value : 1 - progress.value) * width,
  }));
  return (
    <Animated.View style={[styles.clip, side === 'in' ? styles.left : styles.right, clip]}>
      <Text
        style={[style, { width }, side === 'in' ? styles.left : styles.right, styles.abs]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
      >
        {text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 4, paddingHorizontal: 24, opacity: 0.8 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '700', marginBottom: 8 },
  row: { alignSelf: 'stretch' },
  line: { fontSize: 18, lineHeight: 27, fontWeight: '500', textAlign: 'center' },
  spacer: { opacity: 0 },
  clip: { position: 'absolute', top: 0, bottom: 0, overflow: 'hidden' },
  abs: { position: 'absolute', top: 0 },
  left: { left: 0 },
  right: { right: 0 },
});
