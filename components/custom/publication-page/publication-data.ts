// The page's ONE seam to the data layer. Every read and write the page makes
// goes through here, so its suites mock one module. The data area owns what
// sits behind it: the profile query, the paged news list, and the preference
// rows keyed on EVERY name a publication is known by.

import {
    observeActive as observeActivePublicationPreferences,
    weightToPrefKind,
} from '@/lib/database/services/publication-preference-service';
import { normalizePrefName, resolvePrefLevel, type PrefRowLike } from '@/lib/database/services/publication-pref-level';
import {
    setSourcePrefFromUi,
    type SourcePrefUiLevel,
} from '@/lib/database/services/publication-pref-ui-actions';
import {
    resolvePublicationPrefNames,
    type PublicationNameHints,
} from '@/lib/database/services/publisher-source-names';
import {
    getAllVisitedArticles,
    type VisitedArticle,
} from '@/lib/database/services/publication-visit-service';
import { setPublisherKind } from '@/components/custom/publication-preferences/set-publisher-kind';
import logger from '@/lib/logger';
import { visitsForNames } from '@/lib/stats/visited-publications';
import { useCallback, useEffect, useState } from 'react';

export {
    usePublicationProfile,
    type PublicationProfile,
    type PublicationProfileKey,
    type PublicationProfileResult,
    type PublicationProfileState,
} from '@/lib/publication-profile-service';
export {
    usePublicationArticles,
    type PublicationArticlesResult,
    type PublicationArticlesState,
} from '@/lib/hooks/use-publication-articles';

export interface PublicationPrefResult {
    /** The level across every name (fewer wins over more). */
    readonly level: SourcePrefUiLevel;
    /** A mute on any of the names. The level reads a mute as fewer; the page
     *  shows Mute as its own choice. */
    readonly muted: boolean;
    readonly busy: boolean;
    /** Every name the level is read and written under; empty until resolved. */
    readonly names: readonly string[];
    readonly change: (next: PublicationPrefChoice) => void;
}

/** What the page's control writes: a level, or a mute. */
export type PublicationPrefChoice = SourcePrefUiLevel | 'muted';

/** True when an active named row for any of `names` is a mute. */
export function isMutedAcross(rows: readonly PrefRowLike[], names: readonly string[]): boolean {
    const wanted = new Set(names.map(normalizePrefName).filter(Boolean));
    return rows.some(
        (row) =>
            row.scopeKind == null &&
            (row.status === undefined || row.status === 'active') &&
            wanted.has(normalizePrefName(row.publicationName ?? '')) &&
            weightToPrefKind(row.weight) === 'mute',
    );
}

/**
 * More/fewer for ONE publication. The names come from what the device knows
 * (the hints, then memory, then subscriptions; never the network), and a
 * write covers every one of them, so a preference set here reaches every
 * source the publication publishes as, whichever entry point opened the page.
 */
export function usePublicationPref(hints: PublicationNameHints): PublicationPrefResult {
    const [rows, setRows] = useState<readonly PrefRowLike[]>([]);
    const [names, setNames] = useState<readonly string[]>([]);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const sub = observeActivePublicationPreferences().subscribe((next) => setRows(next));
        return () => sub.unsubscribe();
    }, []);

    const hintKey = JSON.stringify([
        hints.publisherId ?? null,
        hints.rawName ?? null,
        hints.publisherName ?? null,
        hints.sourceNames ?? [],
    ]);
    useEffect(() => {
        let cancelled = false;
        resolvePublicationPrefNames(hints)
            .then((resolved) => {
                if (!cancelled) setNames(resolved);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
        // `hintKey` stands in for `hints`, a fresh object on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hintKey]);

    const muted = isMutedAcross(rows, names);
    const change = useCallback(
        (next: PublicationPrefChoice) => {
            if (names.length === 0) return;
            setBusy(true);
            const target = { kind: 'publisher' as const, names };
            // A mute is not a level: the same per-name executor write the
            // Sources rows use. Clearing goes through the level writer, which
            // re-sweeps what the mute had hidden. The level writer never
            // softens a mute to fewer (the card menu relies on that), so an
            // explicit Fewer over a mute clears it first.
            const write = async (): Promise<unknown> => {
                if (next === 'muted') return setPublisherKind(names, 'mute');
                if (muted && next === 'deprioritised') await setSourcePrefFromUi(target, 'none');
                return setSourcePrefFromUi(target, next);
            };
            write()
                .catch((error) => {
                    logger.captureException(error, { tags: { screen: 'PublicationPage', method: 'setPref' } });
                })
                .finally(() => setBusy(false));
        },
        [names, muted],
    );

    return { level: resolvePrefLevel(rows, names), muted, busy, names, change };
}

export type { VisitedArticle };

export interface PublicationHistoryResult {
    readonly state: 'loading' | 'ready';
    /** The reader's visits to this publication in the last 30 days, newest
     *  first, matched on every name it is known by. */
    readonly visits: readonly VisitedArticle[];
    readonly reload: () => void;
}

/**
 * The History sub-tab: the reader's own visits to this publication, from
 * `publication_visits` (the table that already runs Visited; nothing new is
 * recorded). Matched on every known name, normalised and in any country, so a
 * page opened by publisher id shows the same history as one opened by name.
 *
 * Reads when `enabled` turns true (History selected while the page is
 * focused), so a visit recorded while away shows on return.
 */
export function usePublicationHistory(names: readonly string[], enabled: boolean): PublicationHistoryResult {
    const [state, setState] = useState<'loading' | 'ready'>('loading');
    const [visits, setVisits] = useState<readonly VisitedArticle[]>([]);
    const [epoch, setEpoch] = useState(0);
    const namesKey = JSON.stringify(names);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        getAllVisitedArticles()
            .then((all) => {
                if (!cancelled) setVisits(visitsForNames(all, JSON.parse(namesKey) as string[]));
            })
            .catch((error) => {
                logger.captureException(error, { tags: { screen: 'PublicationPage', method: 'history' } });
            })
            .finally(() => {
                if (!cancelled) setState('ready');
            });
        return () => {
            cancelled = true;
        };
    }, [enabled, namesKey, epoch]);

    const reload = useCallback(() => setEpoch((n) => n + 1), []);
    return { state, visits, reload };
}
