// The one Mera button: a 62pt orange circle bottom right, above the tab bar,
// with a hint tooltip beside it. Tapping opens the Mera chat on this page.
//
// Presentational over its inputs: MeraButtonHost decides WHETHER it shows and
// passes the feed status in, because `useFeedStatusMode` loads the scheduler
// and SQLite at import and this file must stay testable without them.
//
// Accessibility: the label always carries the hint (the tooltip is hidden from
// screen readers and fades), and the value is the feed status in the same four
// words the old header mark used. Only "updating" and "up to date" are
// announced here; FeedScreen already announces the capped and error states.

import MeraLogo from '@/components/custom/MeraLogo';
import { Text } from '@/components/ui/text';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { hapticLight } from '@/lib/haptics';
import { takeHintIndex } from '@/lib/navigation/hint-cursor';
import { MERA_BUTTON_SIZE } from '@/lib/navigation/tab-bar';
import { useWebSearchInChat } from '@/lib/stores/mera-protocol-store';
import { useFloatingChatStore, type MeraPageKey } from '@/lib/stores/floating-chat-store';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeOut, useReducedMotion } from 'react-native-reanimated';
import { chatContextFor, hintKeys, interestFactId, statusKey } from './mera-pages';
import { openMeraChat } from './open-mera-chat';
import { tooltipRemainingMs } from './tooltip-visit';

const ORANGE = '#E78A53';
const INK = '#121113';
const LOGO_SIZE = 34;
const TOOLTIP_BG = 'rgba(52,50,55,0.97)';
const TOOLTIP_BORDER = 'rgba(255,255,255,0.12)';

/** The statement of a One interest fact, read lazily: fact-service reaches
 *  WatermelonDB, which must stay out of every suite that renders the button. */
async function factStatement(factId: string): Promise<string | undefined> {
  try {
    const { getFacts } =
      require('@/lib/database/services/fact-service') as typeof import('@/lib/database/services/fact-service');
    return (await getFacts()).find((f) => f.id === factId)?.statement;
  } catch {
    return undefined;
  }
}

export interface MeraButtonProps {
  /** The surface showing (`interest:<id>`, `country:DE`, `facts`…). */
  readonly surface: string;
  readonly page: MeraPageKey;
  readonly mode: FeedStatusMode;
}

const MeraButton: React.FC<MeraButtonProps> = ({ surface, page, mode }) => {
  const { t } = useTranslation();
  // Computed keys (pools, status), so `t` takes them untyped; the en.json
  // presence test in mera-button covers every one.
  const tKey = t as unknown as (key: string, opts?: Record<string, string>) => string;
  const reduceMotion = useReducedMotion();
  const webSearch = useWebSearchInChat();

  // ── hint: one per app session per pool, from L4's cursor ────────────────
  const keys = useMemo(() => hintKeys(page, webSearch), [page, webSearch]);
  const [index, setIndex] = useState<number | null>(null);
  useEffect(() => {
    setIndex(null);
    if (keys.length === 0) return;
    let alive = true;
    void takeHintIndex(page, keys.length).then((i) => {
      if (alive) setIndex(i);
    });
    return () => {
      alive = false;
    };
  }, [page, keys.length]);
  const hint = index !== null && keys.length > 0 ? tKey(keys[index % keys.length]) : null;

  // ── tooltip: the first 10 s of each visit, never restarted by a remount ──
  const [tooltipOn, setTooltipOn] = useState(false);
  useEffect(() => {
    const remaining = tooltipRemainingMs(surface);
    if (hint === null || remaining === 0) {
      setTooltipOn(false);
      return;
    }
    setTooltipOn(true);
    const timer = setTimeout(() => setTooltipOn(false), remaining);
    return () => clearTimeout(timer);
  }, [surface, hint]);

  // ── reading status: announce updating / up to date on change ─────────────
  const prevMode = useRef(mode);
  useEffect(() => {
    const was = prevMode.current;
    prevMode.current = mode;
    if (was === mode) return;
    if (mode === 'processing' || (was === 'processing' && mode === 'idle')) {
      AccessibilityInfo.announceForAccessibility(tKey(statusKey(mode)));
    }
  }, [mode, tKey]);
  const reading = mode === 'processing';

  // ── tap ──────────────────────────────────────────────────────────────────
  const circleRef = useRef<View>(null);
  const publishCenter = useCallback(() => {
    circleRef.current?.measureInWindow((x, y, w, h) => {
      if (w === 0 && h === 0) return;
      useFloatingChatStore.getState().setBubbleCenter({ x: x + w / 2, y: y + h / 2 });
    });
  }, []);
  const onPress = useCallback(async () => {
    void hapticLight();
    publishCenter();
    const factId = interestFactId(surface);
    const subject = factId ? await factStatement(factId) : undefined;
    openMeraChat(chatContextFor(page, subject));
  }, [page, surface, publishCenter]);

  return (
    <View style={styles.row} pointerEvents="box-none">
      {tooltipOn && hint !== null && (
        <Animated.View
          exiting={reduceMotion ? undefined : FadeOut.duration(400)}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.tooltip}
          testID="mera-button-tooltip"
        >
          <Text style={styles.tooltipText} maxFontSizeMultiplier={1.4}>
            {hint}
          </Text>
          <View style={styles.pointer} />
        </Animated.View>
      )}
      <Pressable
        ref={circleRef}
        onLayout={publishCenter}
        onPress={() => void onPress()}
        accessibilityRole="button"
        accessibilityLabel={
          hint !== null ? tKey('meraButton.a11yLabel', { hint }) : t('floatingChat.title')
        }
        accessibilityValue={{ text: tKey(statusKey(mode)) }}
        hitSlop={4}
        style={styles.circle}
        testID="mera-button"
      >
        {/* Reduce Motion: a still ring says "reading" instead of the motion. */}
        {reading && reduceMotion && <View style={styles.ring} testID="mera-button-ring" />}
        <MeraLogo
          size={LOGO_SIZE}
          color={INK}
          animated={reading && !reduceMotion}
          scrollCards={reading && !reduceMotion}
          showsProgress
        />
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  circle: {
    width: MERA_BUTTON_SIZE,
    height: MERA_BUTTON_SIZE,
    borderRadius: MERA_BUTTON_SIZE / 2,
    backgroundColor: ORANGE,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  ring: {
    position: 'absolute',
    top: -5,
    left: -5,
    right: -5,
    bottom: -5,
    borderRadius: MERA_BUTTON_SIZE / 2 + 5,
    borderWidth: 2,
    borderColor: ORANGE,
  },
  tooltip: {
    maxWidth: 190,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: TOOLTIP_BG,
    borderWidth: 1,
    borderColor: TOOLTIP_BORDER,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 6 },
  },
  tooltipText: {
    color: '#E5E5E5',
    fontSize: 12,
    lineHeight: 16,
  },
  // A rotated square half-tucked under the bubble's edge nearest the button
  // (`end`, so RTL mirrors it with the row).
  pointer: {
    position: 'absolute',
    end: -6,
    top: '50%',
    marginTop: -5,
    width: 10,
    height: 10,
    backgroundColor: TOOLTIP_BG,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderColor: TOOLTIP_BORDER,
    borderTopRightRadius: 2,
    transform: [{ rotate: '45deg' }],
  },
});

export default MeraButton;
