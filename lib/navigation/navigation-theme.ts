// navigation-theme — react-navigation themes whose surfaces match the app's
// own background, so no navigator wrapper ever paints a mismatched color.
//
// react-navigation defaults to its LIGHT theme when no ThemeProvider is
// present, and NativeTabsView paints each per-tab wrapper with
// `useTheme().colors.background` — a white flash on tab switch against the
// app's black screens. Providing a dark theme whose background/card are the
// app's dark background removes that flash.

import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

/** The app's dark background: pure black. Screens use `bg-background-0` and the root
 * Stack sets `contentStyle.backgroundColor` to '#000000'. */
const DARK_BACKGROUND = '#000000';

/** Parchment, the light page surface (`--color-background-0` in the light
 * block). Was a placeholder off-white chosen while the app was dark-only; it
 * has to match the real light surface or every navigator wrapper paints a
 * slightly different white than the screens it contains. */
const LIGHT_BACKGROUND = '#F4F3EE';

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
