// navigation-theme — react-navigation themes whose surfaces match the app's
// own background, so no navigator wrapper ever paints a mismatched color.
//
// react-navigation defaults to its LIGHT theme when no ThemeProvider is
// present, and NativeTabsView paints each per-tab wrapper with
// `useTheme().colors.background` — a white flash on tab switch against the
// app's black screens. Providing a dark theme whose background/card are the
// app's dark background removes that flash.

import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

/** The app's dark background: pure black. Screens use `bg-black` and the root
 * Stack sets `contentStyle.backgroundColor` to '#000000'. */
const DARK_BACKGROUND = '#000000';

/** Design-system light background shade (tailwind.config.js `background.light`)
 * — a soft off-white, not pure #FFF. The app is dark-only today; this exists so
 * the navigation theme still tracks the color scheme if that ever changes. */
const LIGHT_BACKGROUND = '#FBFBFB';

const darkNavigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: DARK_BACKGROUND,
    card: DARK_BACKGROUND,
  },
};

const lightNavigationTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: LIGHT_BACKGROUND,
    card: LIGHT_BACKGROUND,
  },
};

export function getNavigationTheme(scheme: 'dark' | 'light'): Theme {
  return scheme === 'light' ? lightNavigationTheme : darkNavigationTheme;
}

export { darkNavigationTheme, lightNavigationTheme };
