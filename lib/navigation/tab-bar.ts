import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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

/** The Mera button's diameter (L6 mounts it once per tab, beside the Stack). */
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
