// The Feed's geo/language context, frozen per READING SESSION, like its sort
// partition (FeedScreen `partitionSnapshot`).
//
// The friction it removes: `useUserGeoLanguageContext` re-loads on every
// publication-preference write (it observes `publication_preferences`), and
// the Feed builds its candidates from it. So "More from this publication" in
// the ••• sheet regrouped and re-banded the stories already on screen about
// 1.6s after the tap: the liked card scrolled away, split-off groups raised a
// "New stories" pill, and the next tap landed on a different article. The
// Feed's rule is a static session order; a preference change reaches it at
// the next session (pull-to-refresh, the pill, a resume), never under the
// reader.
//
// It follows the live context at once only for the first load and an
// app-language change (the whole screen re-renders in the new language
// anyway).

import type { UserGeoLanguageContext } from '@/lib/feed-grouping/geo-language-priority';
import { useRef } from 'react';

export function useSessionGeoLanguageContext(
    live: UserGeoLanguageContext | null,
    /** Bumped at every new reading session (FeedScreen `resetSession`). */
    sessionEpoch: number,
): UserGeoLanguageContext | null {
    const held = useRef<{ ctx: UserGeoLanguageContext | null; epoch: number }>({ ctx: null, epoch: sessionEpoch });
    const h = held.current;
    if (
        live &&
        (h.ctx === null || h.epoch !== sessionEpoch || h.ctx.appLanguageBase !== live.appLanguageBase)
    ) {
        held.current = { ctx: live, epoch: sessionEpoch };
    } else if (h.epoch !== sessionEpoch && !live) {
        held.current = { ctx: h.ctx, epoch: sessionEpoch };
    }
    return held.current.ctx;
}
