// The ONE Mera button of the app, mounted once in app/logged-in/_layout.tsx
// before FloatingChatHost (so the chat panel draws over it). It never
// unmounts on a tab switch, so it never blinks: one instance, whose props and
// position change.
//
// WHERE IT SHOWS is decided by the ROUTE (expo-router segments, host-rules.ts),
// never by focus or by which tab reported a surface; those lag a switch by a
// few frames, which is what made four per-tab buttons blink. Allowlist: every
// screen under app_container, Search and the two article pages. It hides while
// the chat is open, before the stored corner loads, and on a tab while the
// keyboard is up or World's Arrange is open; on Search and an article a
// bottom-corner button rides above the keyboard instead.
//
// WHAT A TAP OPENS: the current page's chat (the last reported surface, held
// while the next one is in flight, so it never goes blank), or on an article
// page Mera on that article (`useReportArticleSurface`).
//
// WHERE IT SITS: above the tab bar on a tab (each tab layout measures and
// publishes the bar's top, `useReportTabBarClearance`; the bar is not in the
// root's safe area), above the home indicator elsewhere. A frame change
// springs to the new spot instead of remounting.
//
// STATES (FinalMeraChat #10-11), both memory-only: the logo grows while the
// chat session is busy with the chat closed, and an orange ring shows while
// an answer that landed with the chat closed is unread, on any screen.
//
// THE BUTTON MOVES (owner, navx): drag it and it snaps to the nearest of four
// physical corners (corner.ts), kept on this phone. The drag lives on the
// button's own detector, outside every pager, so a touch that starts on the
// button never swipes a page. The overlay is box-none: only the 62pt circle
// takes touches.

import {
  useArrangeOpen,
  useArticleSubject,
  useCurrentSurface,
  useTabHeaderBottom,
} from '@/components/custom/nav/current-surface';
import { hapticLight, hapticMedium } from '@/lib/haptics';
import { SPRING } from '@/lib/motion';
import { useTabBarTop } from '@/lib/navigation/tab-bar';
import { useSegments } from 'expo-router';
import {
  useFloatingChatAnswerUnread,
  useFloatingChatIsGenerating,
  useFloatingChatShown,
  type ChatContext,
  type MeraPageKey,
} from '@/lib/stores/floating-chat-store';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, StyleSheet, View } from 'react-native';
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
  clampToFrame,
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
import { buttonContextFor, lastKnown, meraButtonFrame, meraButtonVisible, OVERLAY_PROPS, routeKindFor } from './host-rules';
import { pageKeyFor } from './mera-pages';

const SNAP_SPRING = SPRING.drag;

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

interface PlacedProps {
  readonly surface: string;
  readonly page: MeraPageKey;
  readonly frame: CornerFrame;
  readonly context?: ChatContext;
  /** Off the tabs: a bottom corner lifts above the keyboard. */
  readonly rideKeyboard: boolean;
  readonly working: boolean;
  readonly unread: boolean;
}

/** The button at its corner, with the drag. Its own component so the shared
 *  values live only while there is a measured frame to place it in. */
const Placed: React.FC<PlacedProps> = ({ surface, page, frame, context, rideKeyboard, working, unread }) => {
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
          // It lifts under the finger (FinalMotion: medium haptic).
          runOnJS(hapticMedium)();
          runOnJS(setDragging)(true);
        })
        // Only between the header and the tab bar (owner): never over either.
        .onUpdate((e) => {
          const p = clampToFrame(fromX.value + e.translationX, fromY.value + e.translationY, frame);
          x.value = p.x;
          y.value = p.y;
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
        tooltipSide={tooltipSide(corner)}
        pan={pan}
        dragging={dragging}
        context={context}
        working={working}
        unread={unread}
      />
    </Animated.View>
  );
};

const MeraButtonHost: React.FC = () => {
  const route = routeKindFor(useSegments());
  const onTab = route === 'tab';
  const arrangeOpen = useArrangeOpen();
  const chatOpen = useFloatingChatShown();
  const working = useFloatingChatIsGenerating();
  const unread = useFloatingChatAnswerUnread();
  const keyboardUp = useKeyboardUp();
  const insets = useSafeAreaInsets();
  const tabBarTop = useTabBarTop();

  // The page and the header it sits under, HELD while a switch is in flight:
  // the old page clears its report on blur a few frames before the new one
  // reports, and the button must not go blank or jump in between.
  const reportedSurface = useCurrentSurface();
  const [heldSurface, setHeldSurface] = useState(reportedSurface);
  if (reportedSurface !== null && reportedSurface !== heldSurface) setHeldSurface(reportedSurface);
  const surface = lastKnown(heldSurface, reportedSurface);
  const tabHeaderBottom = useTabHeaderBottom();

  const article = useArticleSubject();
  const context = useMemo(() => buttonContextFor(route, article), [route, article]);


  // No flash on launch: nothing renders until the stored corner is known.
  // Idempotent, so hydrateAllStores reading it first only makes this instant.
  const hydrated = useMeraCornerStore((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) void hydrateMeraButtonCorner();
  }, [hydrated]);

  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  // One box on every route (meraButtonFrame): the button never moves when a
  // screen opens.
  const frame = useMemo<CornerFrame | null>(
    () =>
      size &&
      meraButtonFrame(size, { tabHeaderBottom, tabBarTop, insetsTop: insets.top, insetsBottom: insets.bottom }),
    [size, tabHeaderBottom, tabBarTop, insets.top, insets.bottom],
  );

  if (!meraButtonVisible({ route, hydrated, chatOpen, arrangeOpen, keyboardUp })) return null;
  // Search and the article pages carry no page of their own: the generic set.
  const page: MeraPageKey = (onTab ? pageKeyFor(surface) : null) ?? 'settings';

  return (
    <View
      {...OVERLAY_PROPS}
      style={[StyleSheet.absoluteFill, styles.physical]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize((prev) => (prev?.width === width && prev?.height === height ? prev : { width, height }));
      }}
    >
      {frame && (
        <Placed
          surface={onTab ? (surface ?? '') : route}
          page={page}
          frame={frame}
          context={context}
          rideKeyboard={!onTab}
          working={working}
          unread={unread}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  // Corners are PHYSICAL: top-left stays top-left in RTL.
  physical: { direction: 'ltr' },
  placed: { position: 'absolute', left: 0, top: 0 },
});

export default MeraButtonHost;
