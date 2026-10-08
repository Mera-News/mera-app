// The app's colours, by meaning, for both themes. One place, so the light
// theme (navx2 P12) swaps every consumer at once.
//
// Components read `useColors()`; module-level StyleSheets use `themedStyles`;
// code outside React (a toast built with createElement) reads `currentColors()`
// at render time.
//
// Literal white and black are NOT tokens: text on the orange accent, logos and
// photo scrims stay literal in both themes (the reverted 2026-09-11 chain
// remapped them and flipped labels on orange).

import { THEME_SWITCH_LIVE, useThemeStore } from './theme-store';

export { tint } from './tint';

export type ThemeMode = 'dark' | 'light';

export interface ThemeColors {
    /** The page behind everything. */
    base: string;
    /** A card or row lifted off the base. */
    surface: string;
    /** A surface on a surface (a pressed row, a nested card). */
    surfaceRaised: string;
    /** Hairlines and card edges. */
    line: string;
    /** Primary text. */
    ink: string;
    /** Body text and secondary labels. */
    ink2: string;
    /** Captions, timestamps, placeholders. */
    ink3: string;
    /** The house orange as a FILL (gluestack primary-400). */
    accent: string;
    /** Text and icons ON the accent fill. */
    onAccent: string;
    /** The orange as TEXT on the base (4.5:1). */
    accentText: string;
    /** The orange as a thin mark (icons, rings, 3:1). */
    accentMark: string;
    positive: string;
    negative: string;
    /** An option that is not picked; the ? glyph. */
    muted: string;
    /** A segmented track's fill and border. */
    trackFill: string;
    trackBorder: string;
    /** The ring round a ? button. */
    helpRing: string;
    /** The dim behind a sheet or dialog. */
    scrim: string;
    /** The opaque base under the modal material's glow. */
    modalBase: string;
    /** A floating panel: toasts, notices and menus (FinalInbox). */
    panel: string;
    panelBorder: string;
    /** Night hours on the notification strip (FinalSettings). */
    night: string;
    /** A frosted pill over content (FinalSettings tab pills). */
    glass: string;
    /** The outlined button's 1px edge (Modals board `.sec`). */
    edge: string;
    /** Amber for "needs attention" (the daily limit). */
    warning: string;
    /** Blue for information. */
    info: string;
    /** A translucent header over scrolling content (board header). */
    chrome: string;
}

export const COLORS: Record<ThemeMode, ThemeColors> = {
    dark: {
        base: '#000000',
        surface: 'rgba(255,255,255,0.07)',
        surfaceRaised: 'rgba(255,255,255,0.12)',
        line: 'rgba(255,255,255,0.10)',
        ink: '#FFFFFF',
        ink2: 'rgba(255,255,255,0.70)',
        ink3: 'rgba(255,255,255,0.50)',
        accent: '#E78A53',
        onAccent: '#121113',
        accentText: '#E78A53',
        accentMark: '#E78A53',
        positive: '#4ADE80',
        negative: '#F87171',
        muted: '#D4D4D4',
        trackFill: 'rgba(255,255,255,0.08)',
        trackBorder: 'rgba(255,255,255,0.14)',
        helpRing: 'rgba(255,255,255,0.32)',
        scrim: 'rgba(0,0,0,0.78)',
        modalBase: 'rgb(11,10,12)',
        panel: 'rgb(40,38,42)',
        panelBorder: 'rgba(255,255,255,0.14)',
        night: 'rgba(120,140,200,0.35)',
        glass: 'rgba(40,39,42,0.82)',
        edge: 'rgba(255,255,255,0.3)',
        warning: 'rgb(233,179,83)',
        info: 'rgb(150,190,235)',
        chrome: 'rgba(18,17,19,0.90)',
    },
    // From the FinalLight* boards. Contrast gates: 4.5:1 text, 3:1 marks.
    light: {
        base: '#FFFFFF',
        surface: 'rgba(18,17,19,0.07)',
        surfaceRaised: 'rgba(18,17,19,0.12)',
        line: 'rgba(18,17,19,0.10)',
        ink: '#121113',
        ink2: '#404040',
        ink3: '#5E5E5E',
        accent: '#E78A53',
        onAccent: '#121113',
        accentText: '#A14A17',
        accentMark: '#C8642B',
        positive: '#276B50',
        negative: '#C03A3A',
        muted: '#404040',
        trackFill: 'rgba(18,17,19,0.07)',
        trackBorder: 'rgba(18,17,19,0.14)',
        helpRing: 'rgba(18,17,19,0.32)',
        // The Modals board's light dim (World's arranging overlay uses a lighter
        // rgba(0,0,0,0.28) of its own; sheets and dialogs follow Modals).
        scrim: 'rgba(18,17,19,0.35)',
        modalBase: '#FFFFFF',
        panel: '#FFFFFF',
        panelBorder: 'rgba(18,17,19,0.14)',
        // FinalLightSettings carries the dark value for night; P12 tunes.
        night: 'rgba(120,140,200,0.35)',
        // The light boards' pills and chips: white at 82%, edged by trackBorder.
        glass: 'rgba(255,255,255,0.82)',
        edge: 'rgba(18,17,19,0.3)',
        // The light boards draw no warning or info colour: #9A6200 is the
        // boards' own dark amber; #2563A8 is a derived blue at 4.5:1 on white.
        warning: '#9A6200',
        info: '#2563A8',
        chrome: 'rgba(255,255,255,0.62)',
    },
};

/** The current theme (lib/theme/theme-store.ts); dark whenever the switch is off. */
export function useThemeMode(): ThemeMode {
    const mode = useThemeStore((st) => st.mode);
    return THEME_SWITCH_LIVE ? mode : 'dark';
}

/**
 * The semantic colours as CSS variables, for the Tailwind classes
 * (`bg-surface`, `text-ink`, `border-line`...) through the root provider. Full
 * colour strings, so these classes take no `/alpha` modifier. Literal white and
 * black are not here: text on the accent and logos stay literal.
 */
export function themeCssVars(mode: ThemeMode): Record<string, string> {
    const c = COLORS[mode];
    return {
        '--color-page': c.base,
        '--color-surface': c.surface,
        '--color-surface-raised': c.surfaceRaised,
        '--color-line': c.line,
        '--color-ink': c.ink,
        '--color-ink-2': c.ink2,
        '--color-ink-3': c.ink3,
        '--color-accent': c.accent,
        '--color-on-accent': c.onAccent,
        '--color-accent-text': c.accentText,
        '--color-accent-mark': c.accentMark,
        '--color-positive': c.positive,
        '--color-negative': c.negative,
        '--color-muted': c.muted,
        '--color-panel': c.panel,
        '--color-panel-border': c.panelBorder,
        '--color-edge': c.edge,
        '--color-chrome': c.chrome,
        '--color-warning': c.warning,
        '--color-info': c.info,
    };
}

/**
 * A StyleSheet per theme, for module-level styles that carry colour (a module
 * StyleSheet cannot call a hook). Built once per theme and cached:
 *
 *   const useStyles = themedStyles((c, mode) => StyleSheet.create({ title: { color: c.ink } }));
 *   // in the component:
 *   const styles = useStyles();
 *
 * `mode` is there for the rare value that differs by more than its token.
 */
export function themedStyles<T>(factory: (c: ThemeColors, mode: ThemeMode) => T): () => T {
    const cache: Partial<Record<ThemeMode, T>> = {};
    return function useThemedStyles(): T {
        const mode = useThemeMode();
        return (cache[mode] ??= factory(COLORS[mode], mode));
    };
}

/** The current theme's colours. */
export function useColors(): ThemeColors {
    return COLORS[useThemeMode()];
}

/** The current theme's colours outside a hook, for an element built with
 *  createElement in a render callback (the toast manager). Read it at render
 *  time, never at module scope. */
export function currentColors(): ThemeColors {
    return COLORS[THEME_SWITCH_LIVE ? useThemeStore.getState().mode : 'dark'];
}
