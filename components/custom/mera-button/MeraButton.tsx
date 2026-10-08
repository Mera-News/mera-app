// The one Mera button: a 62pt disc in one of four corners (see corner.ts;
// MeraButtonHost places and drags it). Tapping opens the Mera chat on this
// page. The cone sweeps at rest; Mera reading the news changes nothing here
// (the Feed's status icon shows that).
//
// THE ONE HINT (FinalMeraChat #1): while the person has told Mera no fact at
// all, a tooltip "Tell Mera about you" points at the button. It is DERIVED
// from the facts table (no timer, no rotation, no stored "dismissed" flag) and
// goes for good with the first fact.
//
// Accessibility: the label says what the button does or what it is showing
// (working, an answer ready); the tooltip is hidden from screen readers and
// rides on the label as a hint instead.

import MeraLogo from '@/components/custom/MeraLogo';
import { Text } from '@/components/ui/text';
import { hapticLight } from '@/lib/haptics';
import { EASE, MOTION } from '@/lib/motion';
import { MERA_BUTTON_SIZE } from '@/lib/navigation/tab-bar';
import { useColors } from '@/lib/theme/tokens';
import { useFloatingChatStore, type ChatContext, type MeraPageKey } from '@/lib/stores/floating-chat-store';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, type PanGesture } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { DRAG_ACTIVATION, MERA_CORNERS, setMeraCorner, useMeraCorner, type MeraCorner } from './corner';
import { chatContextFor, interestFactId } from './mera-pages';
import { meraButtonColors, useMeraButtonLook } from './look';
import { openMeraChat } from './open-mera-chat';

// The disc and the mark come from the reader's look (look.ts): white disc and
// dark mark (Light) or the reverse (Dark), so the mark reads as a cut-out. With
// no choice the look follows the theme, as it always did.
// The logo is DRAWN at the working size and scaled down at rest, so it stays
// sharp while it grows (FinalMeraChat #10: 38 to 52 pt).
const LOGO_REST = 38;
const LOGO_WORKING = 52;
const REST_SCALE = LOGO_REST / LOGO_WORKING;
/** The unread ring: 2pt, 5pt clear of the disc (FinalMeraChat #11). */
const RING_GAP = 5;
const RING_WIDTH = 2;
const TOOLTIP_MAX_WIDTH = 190;
const TOOLTIP_GAP = 10;

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

/**
 * True while the facts table is empty. Starts false, so a returning person
 * never sees the tooltip flash before the first read lands. The live query is
 * required lazily (fact-service reaches WatermelonDB) and observed rather than
 * read once: onboarding, a restore and chat all add facts, and not every path
 * bumps a mutation counter.
 */
function useHasNoFacts(): boolean {
  const [none, setNone] = useState(false);
  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    try {
      const { observeFacts } =
        require('@/lib/database/services/fact-service') as typeof import('@/lib/database/services/fact-service');
      sub = observeFacts().subscribe((facts) => setNone(facts.length === 0));
    } catch {
      setNone(false);
    }
    return () => sub?.unsubscribe();
  }, []);
  return none;
}

export interface MeraButtonProps {
  /** The surface showing (`interest:<id>`, `country:DE`, `facts`…). */
  readonly surface: string;
  readonly page: MeraPageKey;
  /** Which side of the button the tooltip sits on (the side facing the
   *  screen's middle). Physical: the host lays this subtree out LTR. */
  readonly tooltipSide?: 'left' | 'right';
  /** The host's drag. Composed with the tap so a drag never opens the chat
   *  and a press or a small wobble never moves the button. */
  readonly pan?: PanGesture;
  /** True while the button is being dragged: the tooltip steps aside. */
  readonly dragging?: boolean;
  /** Mera is working on the reader's request with the chat closed: the logo
   *  grows and its cards scroll. */
  readonly working?: boolean;
  /** Mera's answer is waiting unread: an orange ring circles the button. */
  readonly unread?: boolean;
  /** The chat a tap opens, when not the page's own (the article page opens
   *  Mera on its article). */
  readonly context?: ChatContext;
}

const MeraButton: React.FC<MeraButtonProps> = ({
  surface,
  page,
  tooltipSide = 'left',
  pan,
  dragging = false,
  working = false,
  unread = false,
  context,
}) => {
  const colors = useColors();
  const look = meraButtonColors(useMeraButtonLook());
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const tooltipOn = useHasNoFacts() && !working && !unread;

  // ── working: the logo grows on the UI thread ─────────────────────────────
  const scale = useSharedValue(working ? 1 : REST_SCALE);
  useEffect(() => {
    const to = working ? 1 : REST_SCALE;
    scale.value = reduceMotion
      ? to
      : withTiming(to, {
          duration: working ? MOTION.status.open : MOTION.status.close,
          easing: working ? EASE.arrive : EASE.leave,
        });
  }, [working, reduceMotion, scale]);
  const growStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

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
    if (context) {
      openMeraChat(context);
      return;
    }
    const factId = interestFactId(surface);
    const subject = factId ? await factStatement(factId) : undefined;
    openMeraChat(chatContextFor(page, subject));
  }, [page, surface, context, publishCenter]);

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
  const tooltipColours = { backgroundColor: colors.panel, borderColor: colors.panelBorder };
  return (
    <View style={styles.box} pointerEvents="box-none">
      {tooltipOn && !dragging && (
        <View
          pointerEvents="none"
          style={[styles.tooltipLane, pointsLeft ? styles.laneRight : styles.laneLeft]}
          testID="mera-button-tooltip-lane"
        >
          <Animated.View
            exiting={reduceMotion ? undefined : FadeOut.duration(400)}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.tooltip, tooltipColours]}
            testID="mera-button-tooltip"
          >
            <Text style={[styles.tooltipText, { color: colors.ink }]} maxFontSizeMultiplier={1.4}>
              {t('meraButton.tooltipNew')}
            </Text>
            <View style={[styles.pointer, tooltipColours, pointsLeft ? styles.pointerLeft : styles.pointerRight]} />
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
            working ? t('meraButton.working') : unread ? t('meraButton.answerReady') : t('tutorials.askMera')
          }
          accessibilityHint={tooltipOn ? t('meraButton.tooltipNew') : undefined}
          accessibilityActions={actions}
          onAccessibilityAction={(e) => {
            const name = e.nativeEvent.actionName;
            if (name === 'activate') void onPress();
            else if (name.startsWith('move-')) setMeraCorner(name.slice(5) as MeraCorner);
          }}
          hitSlop={4}
          style={[styles.circle, { backgroundColor: look.disc }]}
          testID="mera-button"
        >
          {unread && (
            <Animated.View
              entering={reduceMotion ? undefined : FadeIn.duration(MOTION.status.open)}
              style={[styles.ring, { borderColor: colors.accentMark }]}
              testID="mera-button-ring"
            />
          )}
          {/* The cone sweeps at rest; the mark itself holds it still off
              screen, in Lite mode and under Reduce Motion. */}
          <Animated.View style={growStyle}>
            <MeraLogo size={LOGO_WORKING} color={look.mark} animated scrollCards={working} />
          </Animated.View>
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
    top: -(RING_GAP + RING_WIDTH),
    left: -(RING_GAP + RING_WIDTH),
    right: -(RING_GAP + RING_WIDTH),
    bottom: -(RING_GAP + RING_WIDTH),
    borderRadius: MERA_BUTTON_SIZE / 2 + RING_GAP + RING_WIDTH,
    borderWidth: RING_WIDTH,
  },
  tooltip: {
    maxWidth: TOOLTIP_MAX_WIDTH,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 12,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 6 },
  },
  tooltipText: {
    fontSize: 13,
    lineHeight: 17,
  },
  // A rotated square half-tucked under the bubble's edge nearest the button.
  pointer: {
    position: 'absolute',
    top: '50%',
    marginTop: -5,
    width: 10,
    height: 10,
    transform: [{ rotate: '45deg' }],
  },
  pointerRight: { right: -6, borderTopWidth: 1, borderRightWidth: 1, borderTopRightRadius: 2 },
  pointerLeft: { left: -6, borderBottomWidth: 1, borderLeftWidth: 1, borderBottomLeftRadius: 2 },
});

export default MeraButton;
