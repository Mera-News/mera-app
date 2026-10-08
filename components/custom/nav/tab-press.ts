// The tab bar's re-tap, pure: is this `tabPress` a re-tap of MY tab, and
// does it scroll or refresh. TabPages listens (page-scroll.ts sends it to the
// visible page). Mechanism, verified in the sources: expo-router's native
// tabs emit a react-navigation `tabPress` (target: the tab route's key) from
// `onNativeFocusChange`, which react-native-screens' tab-bar delegate calls
// even when the tapped tab is already selected; the `tabPress` comes BEFORE
// the `JUMP_TO`, so `isFocused()` is true only for a re-tap.

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

export interface TabNavLike {
  getParent?: () => TabNavLike | undefined;
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
export function findTabAncestor(navigation: TabNavLike): TabNavLike | null {
  let n: TabNavLike | undefined = navigation;
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
