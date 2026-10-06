// The one Mera button: a 62pt white circle in one of four corners (see
// corner.ts; MeraButtonHost places and drags it), with a hint tooltip on the
// side facing the screen's middle. Tapping opens the Mera chat on this page.
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
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, type PanGesture } from 'react-native-gesture-handler';
import Animated, { FadeOut, useReducedMotion } from 'react-native-reanimated';
import { DRAG_ACTIVATION, MERA_CORNERS, setMeraCorner, useMeraCorner, type MeraCorner } from './corner';
import { chatContextFor, hintKeys, interestFactId, statusKey } from './mera-pages';
import { openMeraChat } from './open-mera-chat';
import { tooltipRemainingMs } from './tooltip-visit';

// White circle, dark mark (owner restyle). INK is the app's dark surface
// (gluestack dark `--color-background-0`, rgb 18 17 19; also HEADER_INK in
// nav/QuickSettingsButton), so the mark reads as a cut-out of the page.
const FILL = '#FFFFFF';
const INK = '#121113';
// Only the Reduce Motion "reading" ring: orange reads on the white circle and
// against the dark page, where a dark ring would vanish.
const ORANGE = '#E78A53';
const LOGO_SIZE = 34;
const TOOLTIP_BG = 'rgba(52,50,55,0.97)';
const TOOLTIP_BORDER = 'rgba(255,255,255,0.12)';
const TOOLTIP_MAX_WIDTH = 190;
const TOOLTIP_GAP = 12;

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
  /** Which side of the button the tooltip sits on (the side facing the
   *  screen's middle). Physical: the host lays this subtree out LTR. */
  readonly tooltipSide?: 'left' | 'right';
  /** The host's drag. Composed with the tap so a drag never opens the chat
   *  and a press or a small wobble never moves the button. */
  readonly pan?: PanGesture;
  /** True while the button is being dragged: the tooltip steps aside. */
  readonly dragging?: boolean;
}

const MeraButton: React.FC<MeraButtonProps> = ({
  surface,
  page,
  mode,
  tooltipSide = 'left',
  pan,
  dragging = false,
}) => {
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

  // Tap and drag on ONE detector: the drag activates past DRAG_ACTIVATION, the
  // tap fails past it, so neither ever does the other's job. The tap runs on
  // the JS thread: it only opens the chat.
  const gesture = useMemo(() => {
    const tap = Gesture.Tap()
      .maxDistance(DRAG_ACTIVATION)
      .runOnJS(true)
      .onEnd((_e, success) => {
        if (success) void onPress();
      })
      .withTestId('mera-button-tap');
    return pan ? Gesture.Exclusive(pan, tap) : tap;
  }, [pan, onPress]);

  // Screen readers move it with custom actions (the current corner left out).
  const corner = useMeraCorner();
  const moveLabels: Record<MeraCorner, string> = {
    tl: t('meraButton.moveTopLeft'),
    tr: t('meraButton.moveTopRight'),
    bl: t('meraButton.moveBottomLeft'),
    br: t('meraButton.moveBottomRight'),
  };
  const actions = [
    { name: 'activate' },
    ...MERA_CORNERS.filter((c) => c !== corner).map((c) => ({ name: `move-${c}`, label: moveLabels[c] })),
  ];

  const pointsLeft = tooltipSide === 'right';
  return (
    <View style={styles.box} pointerEvents="box-none">
      {tooltipOn && hint !== null && !dragging && (
        <View
          pointerEvents="none"
          style={[styles.tooltipLane, pointsLeft ? styles.laneRight : styles.laneLeft]}
          testID="mera-button-tooltip-lane"
        >
          <Animated.View
            exiting={reduceMotion ? undefined : FadeOut.duration(400)}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.tooltip}
            testID="mera-button-tooltip"
          >
            <Text style={styles.tooltipText} maxFontSizeMultiplier={1.4}>
              {hint}
            </Text>
            <View style={[styles.pointer, pointsLeft ? styles.pointerLeft : styles.pointerRight]} />
          </Animated.View>
        </View>
      )}
      <GestureDetector gesture={gesture}>
        <View
          ref={circleRef}
          collapsable={false}
          onLayout={publishCenter}
          accessible
          accessibilityRole="button"
          accessibilityLabel={
            hint !== null ? tKey('meraButton.a11yLabel', { hint }) : t('floatingChat.title')
          }
          accessibilityValue={{ text: tKey(statusKey(mode)) }}
          accessibilityActions={actions}
          onAccessibilityAction={(e) => {
            const name = e.nativeEvent.actionName;
            if (name === 'activate') void onPress();
            else if (name.startsWith('move-')) setMeraCorner(name.slice(5) as MeraCorner);
          }}
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
        </View>
      </GestureDetector>
    </View>
  );
};

const styles = StyleSheet.create({
  box: {
    width: MERA_BUTTON_SIZE,
    height: MERA_BUTTON_SIZE,
  },
  // A fixed-width lane beside the button, so the bubble wraps at its own
  // maxWidth and hugs the button's side; vertically centred on the button.
  tooltipLane: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: TOOLTIP_MAX_WIDTH,
    justifyContent: 'center',
  },
  laneLeft: { right: MERA_BUTTON_SIZE + TOOLTIP_GAP, alignItems: 'flex-end' },
  laneRight: { left: MERA_BUTTON_SIZE + TOOLTIP_GAP, alignItems: 'flex-start' },
  circle: {
    width: MERA_BUTTON_SIZE,
    height: MERA_BUTTON_SIZE,
    borderRadius: MERA_BUTTON_SIZE / 2,
    backgroundColor: FILL,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
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
    maxWidth: TOOLTIP_MAX_WIDTH,
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
  // A rotated square half-tucked under the bubble's edge nearest the button.
  pointer: {
    position: 'absolute',
    top: '50%',
    marginTop: -5,
    width: 10,
    height: 10,
    backgroundColor: TOOLTIP_BG,
    borderColor: TOOLTIP_BORDER,
    transform: [{ rotate: '45deg' }],
  },
  pointerRight: { right: -6, borderTopWidth: 1, borderRightWidth: 1, borderTopRightRadius: 2 },
  pointerLeft: { left: -6, borderBottomWidth: 1, borderLeftWidth: 1, borderBottomLeftRadius: 2 },
});

export default MeraButton;
