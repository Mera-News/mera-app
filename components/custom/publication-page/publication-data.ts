// The page's ONE seam to the data layer. Every read and write the page makes
// goes through here, so its suites mock one module. The data area owns what
// sits behind it: the profile query, the paged news list, and the preference
// rows keyed on EVERY name a publication is known by.

import { observeActive as observeActivePublicationPreferences } from '@/lib/database/services/publication-preference-service';
import { resolvePrefLevel, type PrefRowLike } from '@/lib/database/services/publication-pref-level';
import {
    setSourcePrefFromUi,
    type SourcePrefUiLevel,
} from '@/lib/database/services/publication-pref-ui-actions';
import {
    resolvePublicationPrefNames,
    type PublicationNameHints,
} from '@/lib/database/services/publisher-source-names';
import logger from '@/lib/logger';
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
    readonly busy: boolean;
    /** Every name the level is read and written under; empty until resolved. */
    readonly names: readonly string[];
    readonly change: (next: SourcePrefUiLevel) => void;
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

    const change = useCallback(
        (next: SourcePrefUiLevel) => {
            if (names.length === 0) return;
            setBusy(true);
            setSourcePrefFromUi({ kind: 'publisher', names }, next)
                .catch((error) => {
                    logger.captureException(error, { tags: { screen: 'PublicationPage', method: 'setPref' } });
                })
                .finally(() => setBusy(false));
        },
        [names],
    );

    return { level: resolvePrefLevel(rows, names), busy, names, change };
}
