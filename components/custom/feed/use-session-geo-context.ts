// A card list's geo/language context, frozen per READING SESSION: the Feed
// (like its sort partition, FeedScreen `partitionSnapshot`) and a fact's
// screen (FactFeedScreen, one session per visit).
//
// The friction it removes: `useUserGeoLanguageContext` re-loads on every
// publication-preference write (it observes `publication_preferences`), and
// the Feed builds its candidates from it. So "More from this publication" in
// the ••• sheet regrouped and re-banded the stories already on screen about
// 1.6s after the tap: the liked card scrolled away, split-off groups raised a
// "New stories" pill, and the next tap landed on a different article. The
// Feed's rule is a static session order; a preference change reaches it at
// the next session (pull-to-refresh, the pill, a resume), never under the
// reader. A hide is the one exception (`withLiveMutes`).
//
// It follows the live context at once only for the first load and an
// app-language change (the whole screen re-renders in the new language
// anyway).

import type { UserGeoLanguageContext } from '@/lib/algorithms/geo-language-priority';
import type { RankingContext } from '@/lib/feed-ordering/publication-tags';
import { useRef } from 'react';

/**
 * A session's context with the LIVE hides: Not preferred applies at the tap and
 * an Undo lifts it, because the reader asked for exactly that move. Everything
 * else stays held, a star's multiplier included, so nothing regroups or
 * re-sorts. The held object comes back untouched while the hides agree, which
 * keeps every memo on it quiet through a star.
 */
export function withLiveMutes(held: RankingContext | null, live: RankingContext | null): RankingContext | null {
    if (!held || !live) return held;
    const liveMap = live.publicationMultipliers;
    const merged = new Map(held.publicationMultipliers);
    let changed = false;
    for (const [name, m] of liveMap ?? []) {
        if (m === 0 && merged.get(name) !== 0) {
            merged.set(name, 0);
            changed = true;
        }
    }
    for (const [name, m] of held.publicationMultipliers ?? []) {
        if (m !== 0 || liveMap?.get(name) === 0) continue;
        const now = liveMap?.get(name);
        if (now === undefined) merged.delete(name);
        else merged.set(name, now);
        changed = true;
    }
    return changed ? { ...held, publicationMultipliers: merged } : held;
}

export function useSessionGeoLanguageContext<T extends UserGeoLanguageContext>(
    live: T | null,
    /** Changes at every new reading session (FeedScreen: a counter bumped by
     *  `resetSession`; FactFeedScreen: the fact id). */
    sessionEpoch: string | number,
): T | null {
    const held = useRef<{ ctx: T | null; epoch: string | number }>({ ctx: null, epoch: sessionEpoch });
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
