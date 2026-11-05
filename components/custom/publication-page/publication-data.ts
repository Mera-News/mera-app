// The page's ONE seam to the data layer. Every read and write the page makes
// goes through here, so its suites mock one module. The data area owns what
// sits behind it: the profile query, the paged news list, and the preference
// rows keyed on EVERY name a publication is known by.

import { observeActive as observeActivePublicationPreferences } from '@/lib/database/services/publication-preference-service';
import { isStarInherited, resolvePrefLevel, type PrefRowLike } from '@/lib/algorithms/publication-pref-level';
import { setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import {
    fetchPublicationPrefNames,
    resolvePublicationPrefNames,
    type PublicationNameHints,
} from '@/lib/database/services/publisher-source-names';
import {
    getAllVisitedArticles,
    type VisitedArticle,
} from '@/lib/database/services/publication-visit-service';
import { localizedCountryName } from '@/components/custom/publication-preferences/country-search';
import { setNotPreferredWithUndo } from '@/components/custom/publication-preferences/set-not-preferred';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { toastManager } from '@/lib/toast-manager';
import { useTranslation } from 'react-i18next';
import logger from '@/lib/logger';
import { visitsForNames } from '@/lib/stats/visited-publications';
import { useCallback, useEffect, useState } from 'react';

export {
    usePublicationProfile,
    type PublicationProfileKey,
} from '@/lib/publication-profile-service';
export { usePublicationArticles } from '@/lib/hooks/use-publication-articles';

/** What the page's control writes. */
export type PublicationPrefChoice = 'none' | 'prioritised' | 'muted';

export interface PublicationPrefResult {
    /** The level across every name (a mute wins over a preference). */
    readonly level: PublicationPrefChoice;
    readonly muted: boolean;
    /** The country the star comes from, in the app language; null when the publication has its own star or none. */
    readonly inheritedFrom: string | null;
    readonly busy: boolean;
    /** Every name the level is read and written under; empty until resolved. */
    readonly names: readonly string[];
    /** `shownAs` is the name the Undo toast uses. */
    readonly change: (next: PublicationPrefChoice, shownAs?: string) => void;
}

/**
 * Preferred and Not preferred for ONE publication. The state reads the names
 * the device knows (the hints, then memory, then subscriptions). A write covers
 * the publication's full set, fetched first when a publisher id has none yet, so
 * it reaches every source the publication publishes as, whichever entry point
 * opened the page. With no publisher id there is nothing to fetch by.
 */
export function usePublicationPref(hints: PublicationNameHints, countryAlpha3?: string | null): PublicationPrefResult {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();
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

    const level = resolvePrefLevel(rows, names);
    const muted = level === 'muted';
    const inheritedFrom =
        countryAlpha3 && isStarInherited(rows, names, countryAlpha3) ? localizedCountryName(countryAlpha3, appLanguage) : null;
    const change = useCallback(
        (next: PublicationPrefChoice, shownAs?: string) => {
            if (names.length === 0) return;
            setBusy(true);
            const refused = () => toastManager.showInfo(t('you.sources.saveError'));
            const write = async (): Promise<boolean> => {
                // A tap can land before the profile answers, when `names` is only
                // the name that opened the page.
                const all = hints.publisherId
                    ? await fetchPublicationPrefNames({ ...hints, publisherId: hints.publisherId }).catch(() => null)
                    : names;
                if (!all) return false;
                return next === 'muted'
                    ? setNotPreferredWithUndo(all, shownAs || hints.publisherName || hints.rawName || '', t)
                    : (await setSourcePrefFromUi({ kind: 'publisher', names: all }, next)).applied;
            };
            write()
                .then((ok) => {
                    if (!ok) refused();
                })
                .catch((error) => {
                    logger.captureException(error, { tags: { screen: 'PublicationPage', method: 'setPref' } });
                    refused();
                })
                .finally(() => setBusy(false));
        },
        // `hintKey` stands in for `hints`, as above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [names, hintKey, t],
    );

    return { level, muted, inheritedFrom, busy, names, change };
}

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
