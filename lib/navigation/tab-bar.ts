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
 * ## Android is unchanged until measured
 *
 * NativeTabs on Android wraps the tab in a bottom-edge `SafeAreaView` instead,
 * so the answer there differs and is not inferred from iOS. It keeps the
 * previous arithmetic until an emulator capture measures it.
 *
 * Only for components rendered INSIDE the tab navigator. A standalone Stack
 * route has no bar behind it and takes `insets.bottom` alone.
 */
export function tabBarClearance(os: string, insetsBottom: number): number {
  if (os === 'ios') return insetsBottom;
  return insetsBottom + TAB_BAR_HEIGHT;
}

/** `tabBarClearance` for the current platform and the current tab's insets. */
export function useTabBarClearance(): number {
  const insets = useSafeAreaInsets();
  return tabBarClearance(Platform.OS, insets.bottom);
}
