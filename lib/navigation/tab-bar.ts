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
 * clearance without a ref into the navigator. `app_container/_layout.tsx`
 * sets `tabBarStyle.height` to this same value (+ insets.bottom) so the two
 * never drift apart.
 */
export const TAB_BAR_HEIGHT = Platform.OS === 'ios' ? 49 : 56;
