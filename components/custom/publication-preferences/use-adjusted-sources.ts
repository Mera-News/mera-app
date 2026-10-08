// Every publication the reader has tagged (More, Fewer, Muted, Subscribed),
// one entry per publication, plus the country scopes: the Sources screen's
// list and the Profile hub's Sources row read the same entries, so the two
// can never disagree about what is tagged.

import { useEffect, useMemo, useState } from 'react';

import type PublicationPreferenceModel from '@/lib/database/models/PublicationPreference';
import type UserPublicationSubscriptionModel from '@/lib/database/models/UserPublicationSubscription';
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

/** A country scope ("More from Germany"): no publication page, so it keeps
 *  its in-place row. */
export interface AdjustedSource {
    readonly group: PrefRowGroup<PublicationPreferenceModel>;
    /** The row that stands for the group: its strongest setting. */
    readonly pref: PublicationPreferenceModel;
    readonly kind: PublicationPrefKind | null;
}

/** One tagged publication. Opens its publication page. */
export interface TaggedPublication {
    readonly key: string;
    readonly displayName: string;
    readonly publisherId: string | null;
    /** Alpha-3, from a subscription; preference rows carry no country. */
    readonly countryCode: string | null;
    /** More, Fewer or Mute; null when only Subscribed. */
    readonly kind: PublicationPrefKind | null;
    readonly subscribed: boolean;
}

type SubscriptionLike = Pick<UserPublicationSubscriptionModel, 'publisherId' | 'publisherName' | 'countryCode' | 'sourceNamesJson'>;

/**
 * The row that stands for a group: its strongest setting, so the tag shows
 * what the publication's preference IS. Mute and "fewer" win over "more",
 * the same rule the publication page reads by.
 */
export function representativeOf(group: PrefRowGroup<PublicationPreferenceModel>): PublicationPreferenceModel {
    const rows = group.rows;
    if (group.names.length === 0 || rows.length === 1) return rows[0];
    const level = resolvePrefLevel(rows, group.names);
    return level === 'deprioritised'
        ? rows.reduce((a, b) => (b.weight < a.weight ? b : a))
        : rows.reduce((a, b) => (b.weight > a.weight ? b : a));
}

/**
 * Merge preference rows and subscriptions into one entry per publication.
 * A subscription joins a preference group by publisher id, or by any of its
 * SOURCE names (a source is often named unlike its publisher); otherwise it
 * is its own entry. Publications sort by name; scopes keep their order.
 */
export function buildTaggedSources(
    prefs: readonly PublicationPreferenceModel[],
    subscriptions: readonly SubscriptionLike[],
): { publications: TaggedPublication[]; scopes: AdjustedSource[] } {
    const scopes: AdjustedSource[] = [];
    const publications: TaggedPublication[] = [];
    const unmatched = new Set(subscriptions);
    for (const group of groupPrefRowsByPublication(prefs)) {
        const pref = representativeOf(group);
        const kind = weightToPrefKind(pref.weight);
        if (pref.scopeKind != null) {
            scopes.push({ group, pref, kind });
            continue;
        }
        const names = new Set(group.names.map(normalizeSubscriptionName));
        const sub = subscriptions.find(
            (s) =>
                (group.publisherId != null && s.publisherId === group.publisherId) ||
                parseSourceNames(s.sourceNamesJson).some((n) => names.has(normalizeSubscriptionName(n))),
        );
        if (sub) unmatched.delete(sub);
        publications.push({
            key: group.key,
            displayName: sub?.publisherName ?? pref.publicationName,
            publisherId: sub?.publisherId ?? group.publisherId,
            countryCode: sub?.countryCode ?? null,
            kind,
            subscribed: !!sub,
        });
    }
    for (const sub of unmatched) {
        publications.push({
            key: `subscription:${sub.publisherId}`,
            displayName: sub.publisherName,
            publisherId: sub.publisherId,
            countryCode: sub.countryCode,
            kind: null,
            subscribed: true,
        });
    }
    publications.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { publications, scopes };
}

export function useAdjustedSources(): {
    readonly publications: readonly TaggedPublication[];
    readonly scopes: readonly AdjustedSource[];
    readonly isLoading: boolean;
} {
    const [items, setItems] = useState<PublicationPreferenceModel[]>([]);
    const [subscriptions, setSubscriptions] = useState<UserPublicationSubscriptionModel[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    // OBSERVED, both tables: removing a subscription touches only
    // `user_publication_subscriptions`, so a refetch keyed on the preference
    // list would leave the tag showing until a remount.
    useEffect(() => {
        const sub = observeActiveSubscriptions().subscribe(setSubscriptions);
        return () => sub.unsubscribe();
    }, []);

    useEffect(() => {
        const sub = observeActive().subscribe((rows) => {
            setItems(rows);
            setIsLoading(false);
        });
        return () => sub.unsubscribe();
    }, []);

    const { publications, scopes } = useMemo(() => buildTaggedSources(items, subscriptions), [items, subscriptions]);
    return { publications, scopes, isLoading };
}
