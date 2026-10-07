// The app's theme: Light or Dark, chosen on THIS device (Settings > Display >
// Appearance, and the first-launch theme row). No "Automatic" choice (owner):
// it starts at the phone's appearance and then sticks to what was picked.
//
// DEVICE-LEVEL, NOT ACCOUNT-LEVEL: AsyncStorage, like Lite mode, so an account
// switch (which resets the settings table) keeps it.
//
// Never Appearance.setColorScheme: that flips the OS-scheme readers (NativeWind,
// native surfaces) without the app's own tokens and was the spike-5 failure.
// The app's look comes only from this store, through useThemeMode()
// (lib/theme/tokens.ts) and the root provider. iOS keeps its native Dark pin
// (UIUserInterfaceStyle) until the native plan, so the tab bar, keyboard and
// system sheets stay dark there.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';
import { create } from 'zustand';

import type { ThemeMode } from './tokens';

/**
 * Light is live: every area reads its colours from the tokens. Setting this
 * false renders dark whatever is stored and hides the Appearance controls, the
 * one switch to pull light back without a code sweep.
 */
export const THEME_SWITCH_LIVE = true;

export const THEME_STORAGE_KEY = 'app_theme';

/** The phone's own appearance. On iOS the plist pin makes this dark. */
function phoneMode(): ThemeMode {
    return Appearance.getColorScheme() === 'light' ? 'light' : 'dark';
}

interface ThemeState {
    mode: ThemeMode;
}

export const useThemeStore = create<ThemeState>(() => ({ mode: phoneMode() }));

/** Read the stored choice. Never rejects; with nothing stored, the phone's. */
export async function hydrateTheme(): Promise<void> {
    try {
        const stored = await AsyncStorage.getItem(THEME_STORAGE_KEY);
        if (stored === 'light' || stored === 'dark') useThemeStore.setState({ mode: stored });
    } catch {
        // The phone's appearance stays.
    }
}

/** Set by ThemeCrossfade: snapshots the screen so the switch crossfades. */
let crossfade: ((apply: () => void) => Promise<void>) | null = null;
export function registerThemeCrossfade(run: typeof crossfade): void {
    crossfade = run;
}

/** Light or Dark, kept on this device. Crossfades 300 ms when it can. */
export async function setThemeMode(mode: ThemeMode): Promise<void> {
    if (useThemeStore.getState().mode === mode) return;
    const apply = () => useThemeStore.setState({ mode });
    if (crossfade && THEME_SWITCH_LIVE) await crossfade(apply);
    else apply();
    AsyncStorage.setItem(THEME_STORAGE_KEY, mode).catch(() => undefined);
}

/**
 * The Appearance control's state, for Settings > Display and the first-launch
 * checks: the stored choice (not the rendered theme), the setter, and whether
 * the control may be shown at all yet.
 */
export function useAppearanceSetting(): { mode: ThemeMode; setMode: (m: ThemeMode) => void; live: boolean } {
    const mode = useThemeStore((st) => st.mode);
    return { mode, setMode: (m) => void setThemeMode(m), live: THEME_SWITCH_LIVE };
}
