// The "Adjusted" publications, one row per publication: the Sources screen's
// list and the Profile hub's Sources card read the same rows, so the two can
// never disagree about what is adjusted or how it is labelled.

import { useEffect, useMemo, useState } from 'react';

import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import { resolvePrefLevel } from '@/lib/database/services/publication-pref-level';
import {
    observeActive,
    weightToPrefKind,
    type PublicationPrefKind,
} from '@/lib/database/services/publication-preference-service';
import { groupPrefRowsByPublication, type PrefRowGroup } from '@/lib/database/services/publisher-source-names';
import {
    normalizeSubscriptionName,
    observeActive as observeActiveSubscriptions,
    parseSourceNames,
} from '@/lib/database/services/user-publication-subscription-service';

export interface AdjustedSource {
    readonly group: PrefRowGroup<PublicationPreferenceModel>;
    /** The row that stands for the group: its strongest setting. */
    readonly pref: PublicationPreferenceModel;
    readonly kind: PublicationPrefKind | null;
}

/**
 * The row that stands for a group: its strongest setting, so the row's chip
 * shows what the publication's preference IS. Mute and "fewer" win over
 * "more", the same rule the Sources glyph and the publication page read by.
 */
export function representativeOf(group: PrefRowGroup<PublicationPreferenceModel>): PublicationPreferenceModel {
    const rows = group.rows;
    if (group.names.length === 0 || rows.length === 1) return rows[0];
    const level = resolvePrefLevel(rows, group.names);
    return level === 'deprioritised'
        ? rows.reduce((a, b) => (b.weight < a.weight ? b : a))
        : rows.reduce((a, b) => (b.weight > a.weight ? b : a));
}

export function useAdjustedSources(): { readonly rows: readonly AdjustedSource[]; readonly isLoading: boolean } {
    const [items, setItems] = useState<PublicationPreferenceModel[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    // Every SOURCE name covered by an active subscription, normalised.
    const [subscribedSourceNames, setSubscribedSourceNames] = useState<Set<string>>(new Set());

    // OBSERVED, not fetched once per `items` change: removing a subscription
    // touches only `user_publication_subscriptions`, so a refetch keyed on the
    // preference list left the publication hidden until a remount.
    useEffect(() => {
        const sub = observeActiveSubscriptions().subscribe((rows) => {
            const names = new Set<string>();
            for (const row of rows) {
                for (const name of parseSourceNames(row.sourceNamesJson)) names.add(name);
            }
            setSubscribedSourceNames(names);
        });
        return () => sub.unsubscribe();
    }, []);

    useEffect(() => {
        const sub = observeActive().subscribe((rows) => {
            setItems(rows);
            setIsLoading(false);
        });
        return () => sub.unsubscribe();
    }, []);

    const rows = useMemo(() => {
        // Subscriptions have their own section. Matched against the
        // subscription's SOURCE-name set, never its publisher name (a source is
        // often named differently). Country scope rows are never a subscription.
        const adjusted = items.filter(
            (p) => p.scopeKind != null || !subscribedSourceNames.has(normalizeSubscriptionName(p.publicationName)),
        );
        // ONE row per publication: more/fewer is written under every source
        // name of a publication, so raw rows would list it several times.
        return groupPrefRowsByPublication(adjusted).map((group) => {
            const pref = representativeOf(group);
            return { group, pref, kind: weightToPrefKind(pref.weight) };
        });
    }, [items, subscribedSourceNames]);

    return { rows, isLoading };
}
