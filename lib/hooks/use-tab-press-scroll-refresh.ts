import { useNavigation, useRoute } from '@react-navigation/native';
import { useEffect, useRef } from 'react';

import {
  scrollToTopWithRetry,
  type ScrollToOffsetRef,
} from '@/components/custom/feed/scroll-to-top-with-retry';

/**
 * How far from the top the list must be before a re-tap counts as "scroll me up"
 * rather than "refresh me".
 *
 * Deliberately a small POSITIVE number compared with `offset > EPSILON`, never
 * `Math.abs(offset) > EPSILON`. A list whose `contentInsetAdjustmentBehavior` is
 * `automatic` rests at `-adjustedContentInset.top` when parked at the very top —
 * i.e. NEGATIVE, not 0 — while a list left at RN's default `never` rests at 0.
 * react-native-screens flips that property on the scroll view it finds by
 * walking `subviews[0]` from a tab screen (RNSScrollViewHelper), so which of the
 * two a given tab's list gets is not something this hook should have to know.
 * `> EPSILON` reads correctly for both: an absolute comparison would call a
 * negatively-resting list "scrolled" and the second tap could never reach the
 * refresh branch.
 */
export const TAB_PRESS_TOP_EPSILON = 8;

/** What a `tabPress` on an already-focused tab should do. */
export type TabPressAction = 'ignore' | 'scroll-to-top' | 'refresh';

export interface TabPressDecisionInput {
  /** `e.target === route.key` — is this event for MY tab? */
  readonly isForThisTab: boolean;
  /** `navigation.isFocused()` AT EVENT TIME. `tabPress` is emitted BEFORE the
   *  `JUMP_TO` dispatch (expo-router NativeBottomTabsNavigator), so this is
   *  `true` for a re-tap of the active tab and `false` for a switch TO this
   *  tab — which is exactly the discriminator we want. */
  readonly isFocused: boolean;
  /** Current vertical scroll offset. */
  readonly offset: number;
  /** Whether a refresh handler was supplied at all. */
  readonly canRefresh: boolean;
  /** Whether a refresh is already in flight. */
  readonly isRefreshing: boolean;
}

/**
 * The whole decision, as a pure function so it can be unit-tested without a
 * navigator, a list, or a native tab bar.
 *
 * 1st tap on the ALREADY-ACTIVE tab while scrolled down → scroll to top.
 * Tap again once at the top → pull-to-refresh (if the screen has one).
 * Further taps at the top → keep refreshing (unless one is already running).
 * Tapping a DIFFERENT tab → nothing; it just switches.
 */
export function decideTabPressAction({
  isForThisTab,
  isFocused,
  offset,
  canRefresh,
  isRefreshing,
}: TabPressDecisionInput): TabPressAction {
  // Redundant today — @react-navigation/core's useEventEmitter dispatches only
  // to `items[target]` when `target` is defined, so a screen's listener already
  // only sees its own tab's event. Cheap insurance against that changing.
  if (!isForThisTab) return 'ignore';
  // Not focused at event time ⇒ this press is a SWITCH to this tab, not a
  // re-tap. Switching must have no scroll/refresh side effect.
  if (!isFocused) return 'ignore';
  if (offset > TAB_PRESS_TOP_EPSILON) return 'scroll-to-top';
  if (canRefresh && !isRefreshing) return 'refresh';
  return 'ignore';
}

export interface UseTabPressScrollRefreshOptions {
  /** The screen's list ref (FlatList / Animated.FlatList). */
  readonly listRef: ScrollToOffsetRef;
  /** Reads the list's current offset. Cheap — a shared-value or plain ref read. */
  readonly getOffset: () => number;
  /** The screen's pull-to-refresh handler. MUST be the same function the
   *  RefreshControl calls, not the scheduler underneath it. Omit to make the
   *  screen scroll-to-top-only (no screen does today). */
  readonly onRefresh?: () => void;
  /** Live refresh-in-flight flag, so consecutive taps don't stack refreshes. */
  readonly isRefreshing?: boolean;
  /** False for a page that is not the visible one (a warmed pager neighbour):
   *  a re-tap then belongs to the active page, never to this one. */
  readonly enabled?: boolean;
}

interface NavLike {
  getParent?: () => NavLike | undefined;
  getState?: () => NavStateLike | undefined;
  addListener: (type: 'tabPress', callback: (event: { target?: string }) => void) => () => void;
  isFocused: () => boolean;
}

interface NavStateLike {
  type?: string;
  key?: string;
  routes?: readonly { key: string; state?: NavStateLike }[];
}

/** The nearest TAB navigator above this screen, or null. A screen inside a
 *  tab's Stack (navx) does not see the tab's `tabPress` on its own
 *  navigation object; only the tab navigator emits it. */
export function findTabAncestor(navigation: NavLike): NavLike | null {
  let n: NavLike | undefined = navigation;
  while (n) {
    if (n.getState?.()?.type === 'tab') return n;
    n = n.getParent?.();
  }
  return null;
}

/** The key of the tab route whose subtree holds `routeKey` (the screen itself
 *  when it IS the tab route), or null. `tabPress` targets that key. */
export function tabRouteKeyContaining(tabState: NavStateLike | undefined, routeKey: string): string | null {
  const holds = (state: NavStateLike | undefined): boolean =>
    !!state?.routes?.some((r) => r.key === routeKey || holds(r.state));
  for (const r of tabState?.routes ?? []) {
    if (r.key === routeKey || holds(r.state)) return r.key;
  }
  return null;
}

/**
 * Re-tapping the icon of the tab you are already on scrolls its list to the top;
 * tapping again once at the top triggers that screen's pull-to-refresh.
 *
 * Mechanism (verified, not guessed): expo-router's native tabs navigator emits a
 * react-navigation `tabPress` with `target: <tab route key>` from
 * `onNativeFocusChange`, and react-native-screens' tab-bar delegate calls that
 * even when the tapped tab is already selected
 * (`RNSTabBarControllerDelegate.shouldSelectViewController` →
 * `emitOnNativeFocusChangeRequestSelectedTabScreen:` runs unconditionally).
 *
 * Pair this with `disableScrollToTop` on the corresponding `NativeTabs.Trigger`
 * so UIKit's own repeated-selection scroll-to-top special effect does not race
 * this handler.
 */
export function useTabPressScrollRefresh({
  listRef,
  getOffset,
  onRefresh,
  isRefreshing = false,
  enabled = true,
}: UseTabPressScrollRefreshOptions): void {
  const navigation = useNavigation();
  const route = useRoute();

  // Everything the handler reads goes through a ref so the subscription is
  // established once per tab and never torn down/re-added on a refresh-state
  // flip or a new inline closure.
  const latest = useRef({ listRef, getOffset, onRefresh, isRefreshing, enabled });
  latest.current = { listRef, getOffset, onRefresh, isRefreshing, enabled };

  useEffect(() => {
    // `tabPress` is emitted by the TAB navigator only. A page inside a tab's
    // Stack listens there and matches the event against the tab route that
    // holds it. `isFocused()` stays this SCREEN's: with a screen pushed on top
    // (One interest) it is false, the re-tap is the native pop to root, and
    // this handler stays out of it.
    const own = navigation as unknown as NavLike;
    const tabs = findTabAncestor(own);
    if (!tabs) return undefined;

    return tabs.addListener('tabPress', (event) => {
      const {
        listRef: ref,
        getOffset: read,
        onRefresh: refresh,
        isRefreshing: busy,
        enabled: on,
      } = latest.current;
      if (!on) return;
      const action = decideTabPressAction({
        isForThisTab: !!event?.target && event.target === tabRouteKeyContaining(tabs.getState?.(), route.key),
        isFocused: own.isFocused(),
        offset: read(),
        canRefresh: !!refresh,
        isRefreshing: busy,
      });
      if (action === 'scroll-to-top') {
        // Reuse the Feed's verified-and-retried scroll rather than a bare
        // scrollToOffset — a scroll issued while something else is touching
        // this list's layout can be silently absorbed.
        scrollToTopWithRetry(ref, read);
      } else if (action === 'refresh') {
        refresh?.();
      }
    });
  }, [navigation, route.key]);
}
