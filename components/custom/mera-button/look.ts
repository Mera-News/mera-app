// The Mera button's two looks (Settings > Display > Mera button). Light is a
// white disc with a dark mark, Dark a dark disc with a light mark: exactly the
// pairs the button wore in the dark and the light theme before it was a choice.
// With no choice stored the look follows the theme, so nobody's button changes
// until they pick.

import { COLORS, useThemeMode, type ThemeMode } from '@/lib/theme/tokens';
import { useDisplayPrefsStore, type MeraButtonLook } from '@/lib/stores/display-prefs-store';

/** The look the button shows: the reader's choice, else the theme's own. */
export function resolveMeraButtonLook(choice: MeraButtonLook | null, theme: ThemeMode): MeraButtonLook {
    return choice ?? (theme === 'dark' ? 'light' : 'dark');
}

/** Disc and mark colours for a look (the mark reads as a cut-out). */
export function meraButtonColors(look: MeraButtonLook): { disc: string; mark: string } {
    const pair = COLORS[look === 'light' ? 'dark' : 'light'];
    return { disc: pair.ink, mark: pair.base };
}

export function useMeraButtonLook(): MeraButtonLook {
    const choice = useDisplayPrefsStore((s) => s.meraButtonLook);
    return resolveMeraButtonLook(choice, useThemeMode());
}
