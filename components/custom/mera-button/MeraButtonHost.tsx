// Mounts the Mera button for one tab. L1 renders `<MeraButtonHost tab="…" />`
// once per tab, as a sibling AFTER that tab's `<Stack>` in its `_layout.tsx`:
// inside the tab it gets the tab's own insets (useMeraButtonBottom), it stays
// over pages pushed inside the tab (One interest, All facts, Sources), and a
// root push (article detail, Search) covers it natively.
//
// Shows only while ALL hold: this tab is focused, the current surface belongs
// to this tab and has a page key (none on Settings, its sub-screens or Search),
// the chat is closed, Arrange is closed and the keyboard is down. On You it
// fades with the swipe towards Settings.

import { useArrangeOpen, useCurrentSurface } from '@/components/custom/nav/current-surface';
import { tabForSurface, type TabId } from '@/components/custom/nav/page-registry';
import { tabSwipeProgress } from '@/components/custom/nav/swipe-progress';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { usePageOrder } from '@/lib/navigation/page-order';
import { useMeraButtonBottom } from '@/lib/navigation/tab-bar';
import { useFloatingChatIsExpanded } from '@/lib/stores/floating-chat-store';
import React, { useEffect, useState } from 'react';
import { Keyboard, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import MeraButton from './MeraButton';
import { pageKeyFor } from './mera-pages';

const EDGE = 14;

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

const MeraButtonHost: React.FC<{ tab: TabId }> = ({ tab }) => {
  const focused = useIsFocusedSafe();
  const surface = useCurrentSurface();
  const arrangeOpen = useArrangeOpen();
  const chatOpen = useFloatingChatIsExpanded();
  const keyboardUp = useKeyboardUp();
  const mode = useFeedStatusMode();
  const bottom = useMeraButtonBottom();

  const progress = tabSwipeProgress(tab);
  const settingsIndex = usePageOrder('you').indexOf('settings');
  const fadeOnYou = tab === 'you';
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: fadeOnYou ? youFade(progress.value, settingsIndex) : 1,
  }));

  const page = surface !== null && tabForSurface(surface) === tab ? pageKeyFor(surface) : null;
  if (!focused || surface === null || page === null || chatOpen || arrangeOpen || keyboardUp) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.anchor, { bottom }, fadeStyle]}
    >
      <MeraButton surface={surface} page={page} mode={mode} />
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    end: EDGE,
  },
});

export default MeraButtonHost;
