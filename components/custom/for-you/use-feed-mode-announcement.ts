// Announce entering the capped or error state to a screen reader.
//
// A label change alone is not announced by VoiceOver/TalkBack unless focus
// happens to be on the element, and entering the capped state is precisely the
// moment the reader is somewhere else in the list. `announceForAccessibility`
// is a no-op when no screen reader is running.
//
// Called by the SCREEN (FeedScreen, and DashboardStatsCard on the Dashboard),
// never by the Mera mark. The Dashboard has no mark, and the Feed's mounts only
// while it is needed: a mark mounting already capped would seed "previous" with
// the new state and miss the very transition this exists for.
//
// Seeded from the screen's FIRST render, so a screen that mounts already capped
// does not announce a state the user navigated into on purpose.

import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo } from 'react-native';
import { a11yStateKey } from './status-ink';

export function useFeedModeAnnouncement(mode: FeedStatusMode): void {
    const { t } = useTranslation();
    // `a11yStateKey` is computed from the mode; see its own note on `tAny`.
    const tAny = t as unknown as (key: string) => string;
    const prevMode = useRef<FeedStatusMode>(mode);
    useEffect(() => {
        const was = prevMode.current;
        prevMode.current = mode;
        if (was === mode) return;
        if (mode !== 'limited' && mode !== 'error') return;
        AccessibilityInfo.announceForAccessibility(tAny(a11yStateKey(mode)));
    }, [mode, tAny]);
}
