// Announce entering the capped or error state to a screen reader.
//
// A label change alone is not announced by VoiceOver/TalkBack unless focus
// happens to be on the element, and entering the capped state is precisely the
// moment the reader is somewhere else in the list. `announceForAccessibility`
// is a no-op when no screen reader is running.
//
// Called by the SCREEN (FeedScreen), never by the Mera button: one owner keeps
// the announcement independent of whatever the button's lifecycle becomes (a
// button mounting already capped would seed "previous" with the new state and
// miss the very transition this exists for).
//
// Seeded from the screen's FIRST render, so a screen that mounts already capped
// does not announce a state the user navigated into on purpose.

import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { useReadHold } from '@/lib/subscription/read-hold';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo } from 'react-native';
import { a11yStateKey } from './status-ink';

/** The resetAt the limited state was last announced for, so a hold is
 *  announced once however many times the screen remounts. */
let lastAnnouncedResetAt: number | null = null;

export function useFeedModeAnnouncement(mode: FeedStatusMode): void {
    const { t } = useTranslation();
    // `a11yStateKey` is computed from the mode; see its own note on `tAny`.
    const tAny = t as unknown as (key: string) => string;
    const { resetAt } = useReadHold();
    const prevMode = useRef<FeedStatusMode>(mode);
    const heldUntil = useRef<number | null>(null);
    useEffect(() => {
        const was = prevMode.current;
        prevMode.current = mode;
        if (mode === 'limited' && resetAt != null) heldUntil.current = resetAt;
        if (was === mode) return;
        if (mode === 'limited') {
            if (resetAt == null || resetAt === lastAnnouncedResetAt) return;
            lastAnnouncedResetAt = resetAt;
            AccessibilityInfo.announceForAccessibility(tAny(a11yStateKey(mode)));
            return;
        }
        if (was === 'limited' && heldUntil.current != null && Date.now() < heldUntil.current) {
            AccessibilityInfo.announceForAccessibility(t('feedStatus.readingAgainA11y'));
            return;
        }
        if (mode === 'error') AccessibilityInfo.announceForAccessibility(tAny(a11yStateKey(mode)));
    }, [mode, resetAt, t, tAny]);
}
