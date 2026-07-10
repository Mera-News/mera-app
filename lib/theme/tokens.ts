// Theme-aware hex tokens for places Tailwind classes can't reach:
// icon `color=` props, `placeholderTextColor`, StatusBar, Stack contentStyle,
// native config surfaces. Values mirror the CSS-variable palette in
// components/ui/gluestack-ui-provider/config.ts — change them together.

import { useColorScheme } from 'nativewind';

export const themeTokens = {
    dark: {
        background: '#1E1E24', // Shadow Grey — page bg
        surface: '#303039', // background-100
        border: '#3F3F49', // outline-100
        icon: '#F9F8F4', // typography-950
        iconMuted: '#B1ADA1', // Silver / typography-500
        iconFaint: '#8E8B83', // typography-400
        primary: '#E78A53', // Toasted Almond / primary-400
        onPrimary: '#1E1E24',
        error: '#EF4444',
        success: '#10B981',
        warning: '#F59E0B',
        info: '#57C2F6', // info-600
    },
    light: {
        background: '#F4F3EE', // Parchment — page bg
        surface: '#E7E6DF', // background-100
        border: '#CBC8C0', // outline-200
        icon: '#1E1E24', // typography-950
        iconMuted: '#706C63', // typography-500
        iconFaint: '#8E8A80', // typography-400
        primary: '#CD703A', // darkened Almond / primary-500
        onPrimary: '#F4F3EE',
        error: '#DC2626',
        success: '#0E9F6E',
        warning: '#B45309',
        info: '#0B8DCD', // info-600
    },
} as const;

export type ThemeColors = (typeof themeTokens)['dark' | 'light'];

export function useThemeColors(): ThemeColors {
    const { colorScheme } = useColorScheme();
    return themeTokens[colorScheme === 'light' ? 'light' : 'dark'];
}
