import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { Platform, useWindowDimensions, type View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';

import logger from '@/lib/logger';

/**
 * Height of the bottom tab bar's own content area, excluding the device's
 * bottom safe-area inset.
 *
 * The bar is `NativeTabs` (expo-router unstable-native-tabs), which owns its
 * own height and never exposes it to JS, so this is a conservative ESTIMATE,
 * not the rendered height. Do not add it to `useSafeAreaInsets().bottom` inside
 * a tab screen yourself: use `useTabBarClearance()` below, which knows when the
 * inset already includes the bar.
 */
export const TAB_BAR_HEIGHT = Platform.OS === 'ios' ? 49 : 56;

/**
 * Bottom clearance for an overlay or list end drawn INSIDE a tab screen, so it
 * sits above the tab bar and the home indicator. Pure, so both platforms are
 * testable from one jest run.
 *
 * ## Why iOS returns the inset alone
 *
 * On iOS, NativeTabs wraps every tab screen in its OWN `SafeAreaProvider`
 * (`expo-router/build/native-tabs/NativeTabsView.js`), which measures the tab's
 * native safe area. UIKit's tab bar controller puts the bar inside that area,
 * so `insets.bottom` in a tab screen is about 83-85pt on a Face ID iPhone, not
 * the 34pt home indicator. Adding `TAB_BAR_HEIGHT` on top counted the bar
 * twice: measured on device, the Dashboard's share FAB sat 154pt from the
 * bottom (20 + 85 + 49) and 70pt above the bar instead of 20.
 *
 * ## Why Android returns zero
 *
 * NativeTabs on Android wraps the tab in a bottom-edge `SafeAreaView`, and the
 * tab's content area already ENDS at the bar. Measured on an API 35 emulator
 * (gesture nav, 24dp inset, bar 80.4dp): every list viewport ended exactly at
 * the bar's top edge, and the old `insets.bottom + TAB_BAR_HEIGHT` floated the
 * Visited share FAB 99.8dp above the bar instead of 20.
 *
 * Only for components rendered INSIDE the tab navigator. A standalone Stack
 * route has no bar behind it and takes `insets.bottom` alone.
 */
export function tabBarClearance(os: string, insetsBottom: number): number {
  if (os === 'android') return 0;
  return insetsBottom;
}

/** `tabBarClearance` for the current platform and the current tab's insets. */
export function useTabBarClearance(): number {
  const insets = useSafeAreaInsets();
  return tabBarClearance(Platform.OS, insets.bottom);
}

/** The Mera button's diameter (one app-wide button, mounted in app/logged-in/_layout). */
export const MERA_BUTTON_SIZE = 62;
/** Gap between the tab bar's top edge and the button's bottom edge. 13 until
 *  spike 3 measures it on iOS 26 and Android. */
export const MERA_BUTTON_BAR_GAP = 13;
/** The Mera button's distance from the screen's left or right edge. */
export const MERA_BUTTON_EDGE = 14;
/** Clear space between a list's last item and the button's top edge. */
export const LIST_END_CONTENT_GAP = 12;
/** What every list ends with ABOVE the tab bar, so nothing sits under the
 *  button. Derived, never a literal: the 172pt in the design is this plus the
 *  bar, measured from the screen bottom on iOS (inset 85 already includes the
 *  bar there; on Android the content area ends at the bar). */
export const LIST_END_RESERVE = MERA_BUTTON_BAR_GAP + MERA_BUTTON_SIZE + LIST_END_CONTENT_GAP;

/** List-end padding for a page inside a tab. Pure, for both platforms. */
export function listEndClearance(os: string, insetsBottom: number): number {
  return tabBarClearance(os, insetsBottom) + LIST_END_RESERVE;
}

/** `listEndClearance` for the current platform and tab insets. */
export function useListEndClearance(): number {
  const insets = useSafeAreaInsets();
  return listEndClearance(Platform.OS, insets.bottom);
}

/** The Mera button's bottom offset inside a tab (its parent ends where the
 *  tab's content ends). */
export function meraButtonBottom(os: string, insetsBottom: number): number {
  return tabBarClearance(os, insetsBottom) + MERA_BUTTON_BAR_GAP;
}

export function useMeraButtonBottom(): number {
  const insets = useSafeAreaInsets();
  return meraButtonBottom(Platform.OS, insets.bottom);
}

/**
 * How far the tab bar's top sits above the WINDOW's bottom edge, measured from
 * inside a tab: the gap between the tab's content and the window bottom (0 on
 * iOS, where content runs under the bar; the bar and the nav inset on Android)
 * plus the clearance the tab's insets already carry (the bar itself on iOS).
 * The one Mera button lives at the app root, where the bar is not in the
 * safe area, so it needs this from a tab.
 */
export function tabBarTopFromBottom(
  windowHeight: number,
  contentBottomInWindow: number,
  os: string,
  insetsBottom: number,
): number {
  return Math.max(0, windowHeight - contentBottomInWindow) + tabBarClearance(os, insetsBottom);
}

/** The last value a tab reported: the same for every tab, so it is stable
 *  once the first tab has mounted. Null until then. */
export const useTabBarTopStore = create<{ top: number | null }>(() => ({ top: null }));

export function useTabBarTop(): number | null {
  return useTabBarTopStore((s) => s.top);
}

/**
 * Called in each tab's layout: measures that tab's content box and publishes
 * `tabBarTopFromBottom`. Returns the ref and onLayout for the layout's root view.
 *
 * It measures again whenever the insets or the window change, not only on
 * layout: on iOS the tab's own safe area (which holds the bar) lands AFTER the
 * first layout, and a value published from the earlier, smaller inset put the
 * Mera button over the bar with no later layout to correct it.
 */
export function useReportTabBarClearance(): { ref: RefObject<View | null>; onLayout: () => void } {
  const ref = useRef<View | null>(null);
  const windowHeight = useWindowDimensions().height;
  const insetsBottom = useSafeAreaInsets().bottom;
  const onLayout = useCallback(() => {
    ref.current?.measureInWindow((_x, y, _w, h) => {
      if (!Number.isFinite(y) || !Number.isFinite(h) || h <= 0) return;
      const top = Math.round(tabBarTopFromBottom(windowHeight, y + h, Platform.OS, insetsBottom));
      if (__DEV__) {
        logger.info('[tab-bar] measured', { windowHeight, contentBottom: y + h, insetsBottom, barTopFromBottom: top });
      }
      if (useTabBarTopStore.getState().top !== top) useTabBarTopStore.setState({ top });
    });
  }, [windowHeight, insetsBottom]);
  useEffect(() => {
    onLayout();
  }, [onLayout]);
  return { ref, onLayout };
}
