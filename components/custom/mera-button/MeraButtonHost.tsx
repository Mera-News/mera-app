// Mounts the Mera button.
//
// In a TAB: `<MeraButtonHost tab="…" />` once per tab, as a sibling AFTER that
// tab's `<Stack>` in its `_layout.tsx`: inside the tab it gets the tab's own
// insets (useMeraButtonBottom) and stays over pages pushed inside the tab (One
// interest, All facts, Sources). Shows only while ALL hold: this tab is
// focused, the current surface belongs to this tab and has a page key, the
// chat is closed, Arrange is closed and the keyboard is down. On You it fades
// with the swipe towards Settings.
//
// On a ROOT push, which covers the tab's button natively: `<MeraButtonHost
// root />` (Search) or `<MeraButtonHost root article={…} />` (the article
// page, whose tap opens Mera on that article), as the screen's LAST child.
// Plain insets (no tab bar), shown while that screen is focused and the chat
// is closed, and a bottom-corner button rides above the keyboard instead of
// hiding, because Search focuses its field on arrival.
//
// THE BUTTON MOVES (owner, navx): drag it and it snaps to the nearest of four
// physical corners (corner.ts), shared by every tab and kept on this phone.
// The drag lives on the button's own detector, a sibling of the tab's Stack
// and outside every pager, so a touch that starts on the button never swipes a
// page. The overlay is box-none: only the 62pt circle takes touches.

import {
  useArrangeOpen,
  useCurrentSurface,
  useHeaderBottom,
} from '@/components/custom/nav/current-surface';
import { tabForSurface, type TabId } from '@/components/custom/nav/page-registry';
import { tabSwipeProgress } from '@/components/custom/nav/swipe-progress';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { hapticLight } from '@/lib/haptics';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { usePageOrder } from '@/lib/navigation/page-order';
import { MERA_BUTTON_BAR_GAP, MERA_BUTTON_SIZE, useMeraButtonBottom } from '@/lib/navigation/tab-bar';
import {
  useFloatingChatIsExpanded,
  type ChatContext,
  type MeraPageKey,
} from '@/lib/stores/floating-chat-store';
import { articleChatContext, type AskMeraSubject } from '@/components/custom/floating-chat/ask-mera';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DRAG_ACTIVATION,
  cornerPoint,
  hydrateMeraButtonCorner,
  nearestCorner,
  setMeraCorner,
  tooltipSide,
  useMeraCorner,
  useMeraCornerStore,
  type CornerFrame,
  type MeraCorner,
} from './corner';
import MeraButton from './MeraButton';
import { pageKeyFor } from './mera-pages';

const EDGE = 14;
const TOP_GAP = 12;
/** Height of a page header below the safe area, for a surface that reports
 *  no header bottom (the You-stack screens). */
const HEADER_FALLBACK = 52;
const SNAP_SPRING = { damping: 18, stiffness: 220 };

function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setUp(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return up;
}

/** Opacity on You: 1 on Profile, 0 on Settings, following the swipe. 1 on
 *  every other tab. Settings is wherever the reader put it in the order. */
export function youFade(progress: number, settingsIndex: number): number {
  'worklet';
  if (settingsIndex < 0) return 1;
  return Math.min(1, Math.abs(progress - settingsIndex));
}

interface PlacedProps {
  readonly surface: string;
  readonly page: MeraPageKey;
  readonly mode: FeedStatusMode;
  readonly frame: CornerFrame;
  readonly context?: ChatContext;
  /** Root hosts: a bottom corner lifts above the keyboard. */
  readonly rideKeyboard: boolean;
}

/** The button at its corner, with the drag. Its own component so the shared
 *  values live only while there is a measured frame to place it in. */
const Placed: React.FC<PlacedProps> = ({ surface, page, mode, frame, context, rideKeyboard }) => {
  const corner = useMeraCorner();
  const reduceMotion = useReducedMotion();
  // The keyboard's top, as a negative translate (0 while it is down). Its
  // height counts the home-indicator inset the frame's bottom already holds.
  const keyboard = useReanimatedKeyboardAnimation();
  const lift = rideKeyboard && (corner === 'bl' || corner === 'br');
  const insetBottom = useSafeAreaInsets().bottom;
  const start = cornerPoint(corner, frame);
  const x = useSharedValue(start.x);
  const y = useSharedValue(start.y);
  const fromX = useSharedValue(0);
  const fromY = useSharedValue(0);
  const [dragging, setDragging] = useState(false);

  // A drop already sent the button to its corner; the store update it makes
  // must not restart that spring (which would swallow the snap haptic).
  const dropped = useRef<MeraCorner | null>(null);
  const onDrop = useCallback((next: MeraCorner) => {
    dropped.current = next;
    setMeraCorner(next);
  }, []);

  // Moved from outside a drag (hydrate, an accessibility action, a new frame).
  useEffect(() => {
    if (dropped.current === corner) {
      dropped.current = null;
      return;
    }
    const p = cornerPoint(corner, frame);
    x.value = reduceMotion ? p.x : withSpring(p.x, SNAP_SPRING);
    y.value = reduceMotion ? p.y : withSpring(p.y, SNAP_SPRING);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corner, frame.width, frame.height, frame.top, frame.bottom, reduceMotion]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(DRAG_ACTIVATION)
        .onStart(() => {
          fromX.value = x.value;
          fromY.value = y.value;
          runOnJS(setDragging)(true);
        })
        .onUpdate((e) => {
          x.value = fromX.value + e.translationX;
          y.value = fromY.value + e.translationY;
        })
        .onEnd(() => {
          const half = frame.size / 2;
          const next = nearestCorner(x.value + half, y.value + half, frame.width, frame.height);
          const p = cornerPoint(next, frame);
          if (reduceMotion) {
            x.value = p.x;
            y.value = p.y;
            runOnJS(hapticLight)();
          } else {
            x.value = withSpring(p.x, SNAP_SPRING, (done) => {
              if (done) runOnJS(hapticLight)();
            });
            y.value = withSpring(p.y, SNAP_SPRING);
          }
          runOnJS(onDrop)(next);
        })
        .onFinalize(() => {
          runOnJS(setDragging)(false);
        })
        .withTestId('mera-button-pan'),
    [frame, reduceMotion, onDrop, x, y, fromX, fromY],
  );

  const moveStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { translateY: y.value + (lift ? Math.min(0, keyboard.height.value + insetBottom) : 0) },
    ],
  }));

  return (
    <Animated.View pointerEvents="box-none" style={[styles.placed, moveStyle]}>
      <MeraButton
        surface={surface}
        page={page}
        mode={mode}
        tooltipSide={tooltipSide(corner)}
        pan={pan}
        dragging={dragging}
        context={context}
      />
    </Animated.View>
  );
};

export type MeraButtonHostProps =
  | { readonly tab: TabId }
  | { readonly root: true; readonly article?: AskMeraSubject };

const MeraButtonHost: React.FC<MeraButtonHostProps> = (props) => {
  const root = 'root' in props;
  const tab = root ? null : props.tab;
  const focused = useIsFocusedSafe();
  const surface = useCurrentSurface();
  const arrangeOpen = useArrangeOpen();
  const chatOpen = useFloatingChatIsExpanded();
  const keyboardUp = useKeyboardUp();
  const mode = useFeedStatusMode();
  const tabBottom = useMeraButtonBottom();
  const insets = useSafeAreaInsets();
  const bottom = root ? insets.bottom + MERA_BUTTON_BAR_GAP : tabBottom;
  // The SHOWN header's bottom: a top-corner button never follows a header
  // that collapses on scroll (owner ruling: nothing jumps while reading). A
  // root push reports none of its own, so it never reads a tab's.
  const reportedHeader = useHeaderBottom();
  const headerBottom = (root ? null : reportedHeader) ?? insets.top + HEADER_FALLBACK;
  const article = root ? props.article : undefined;
  const context = useMemo(() => (article ? articleChatContext(article) ?? undefined : undefined), [article]);

  // No flash on launch: nothing renders until the stored corner is known.
  // Idempotent, so hydrateAllStores reading it first only makes this instant.
  const hydrated = useMeraCornerStore((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) void hydrateMeraButtonCorner();
  }, [hydrated]);

  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const frame = useMemo<CornerFrame | null>(
    () =>
      size && {
        width: size.width,
        height: size.height,
        top: headerBottom + TOP_GAP,
        bottom,
        inset: EDGE,
        size: MERA_BUTTON_SIZE,
      },
    [size, headerBottom, bottom],
  );

  const progress = tabSwipeProgress(tab ?? 'you');
  const settingsIndex = usePageOrder('you').indexOf('settings');
  const fadeOnYou = tab === 'you';
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: fadeOnYou ? youFade(progress.value, settingsIndex) : 1,
  }));

  const page: MeraPageKey | null = root
    ? 'settings'
    : surface !== null && tabForSurface(surface) === tab
      ? pageKeyFor(surface)
      : null;
  if (!hydrated || !focused || page === null || chatOpen || (!root && (arrangeOpen || keyboardUp))) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, styles.physical, fadeStyle]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize((prev) => (prev?.width === width && prev?.height === height ? prev : { width, height }));
      }}
      testID="mera-button-overlay"
    >
      {frame && (
        <Placed
          surface={root ? (article ? 'article' : 'search') : (surface ?? '')}
          page={page}
          mode={mode}
          frame={frame}
          context={context}
          rideKeyboard={root}
        />
      )}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  // Corners are PHYSICAL: top-left stays top-left in RTL.
  physical: { direction: 'ltr' },
  placed: { position: 'absolute', left: 0, top: 0 },
});

export default MeraButtonHost;
