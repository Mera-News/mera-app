import { Platform } from 'react-native';

/**
 * Height of the bottom tab bar's own content area — excludes the bottom
 * safe-area inset, which the navigator (and any overlay computing its own
 * clearance) adds on top of this via `useSafeAreaInsets().bottom`.
 *
 * Pinned as an explicit constant — rather than reading it off the navigator at
 * runtime — because the default height varies with label visibility (this
 * tab bar renders icon-only, `tabBarShowLabel: false`) and because
 * screen-level overlays that render OUTSIDE the Tabs navigator (the floating
 * chat bubble, the scroll-to-top FAB) need to compute an accurate bottom
 * clearance without a ref into the navigator.
 *
 * NOTE: since the tab bar switched to `NativeTabs` (expo-router
 * unstable-native-tabs / liquid-glass) in `app_container/_layout.tsx`, the
 * native bar owns its own height and no longer reads this constant — the real
 * native height isn't exposed to JS. This value is now purely a conservative
 * bottom-clearance estimate for the OUTSIDE-the-navigator overlays above, so
 * it may not exactly match the rendered native bar. Kept because those
 * overlays (BrowseFeedScreen, ForYouScreen, ExploreScreen, the FABs and chat
 * bubbles) still rely on it for padding/clearance.
 */
export const TAB_BAR_HEIGHT = Platform.OS === 'ios' ? 49 : 56;
