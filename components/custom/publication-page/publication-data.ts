// The page's ONE seam to the data layer. Every read the page makes goes
// through here, so the page's suites mock one module and the wiring to the
// data area's hooks is a single file.
//
// TEMPORARY BODY: the data area's hooks (`usePublicationProfile` in
// `lib/publication-profile-service.ts`, `usePublicationArticles` in
// `lib/hooks/use-publication-articles.ts`) land in this same wave. Until they
// do, the profile reads as `unsupported` (the page's "server does not know
// this query" state: the entry point's own name and country, no news), which
// is the safe answer for a server that has not shipped the query. Replace the
// two bodies with re-exports once those modules exist; the types below are
// the agreed signatures and must not change shape.

import { observeActive as observeActivePublicationPreferences } from '@/lib/database/services/publication-preference-service';
import {
    setSourcePrefFromUi,
    type SourcePrefUiLevel,
} from '@/lib/database/services/publication-pref-ui-actions';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PublicationOrder } from './open-publication-page';

export type PublicationProfileState =
    | 'loading'
    | 'ready'
    | 'error'
    | 'offline'
    | 'unsupported'
    | 'notFound';

export interface PublicationProfile {
    readonly newsPublisherId: string;
    readonly name: string;
    readonly displayName?: string | null;
    readonly homepageUrl?: string | null;
    readonly publicationType?: string | null;
    readonly categories?: readonly string[] | null;
    readonly languages?: readonly string[] | null;
    readonly isOfficial: boolean;
    readonly countryCode: string;
    readonly countryName?: string | null;
    readonly sourceNames: readonly string[];
    readonly subscriptionUri?: string | null;
}

export type PublicationProfileKey =
    | { readonly publisherId: string }
    | { readonly rawName: string; readonly countryCode: string };

export interface PublicationProfileResult {
    readonly state: PublicationProfileState;
    readonly profile: PublicationProfile | null;
    readonly retry: () => void;
}

export type PublicationArticlesState =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'error'
    | 'loadingMore'
    | 'loadMoreError'
    | 'refreshing'
    | 'offline';

export interface PublicationArticlesResult {
    readonly articles: readonly NewsArticle[];
    readonly state: PublicationArticlesState;
    readonly loadMore: () => void;
    readonly hasMore: boolean;
    readonly refresh: () => void;
}

const noop = () => {};

export function usePublicationProfile(_key: PublicationProfileKey | null): PublicationProfileResult {
    return { state: 'unsupported', profile: null, retry: noop };
}

export function usePublicationArticles(
    _publisherId: string | null,
    _order: PublicationOrder,
): PublicationArticlesResult {
    return { articles: [], state: 'idle', loadMore: noop, hasMore: false, refresh: noop };
}

export interface PublicationPrefResult {
    /** The level across every name (fewer wins over more). */
    readonly level: SourcePrefUiLevel;
    readonly busy: boolean;
    readonly change: (next: SourcePrefUiLevel) => void;
}

const normName = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * More/fewer for one publication, known by several names (its source names,
 * the publisher name, the name the entry point showed). TEMPORARY BODY, like
 * the two hooks above: it reads and writes each name with today's per-name
 * APIs until the data area's publisher-level target lands.
 */
export function usePublicationPref(names: readonly string[]): PublicationPrefResult {
    const [rows, setRows] = useState<readonly { publicationName: string; weight: number; scopeKind?: string | null }[]>([]);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        const sub = observeActivePublicationPreferences().subscribe((next) => setRows(next));
        return () => sub.unsubscribe();
    }, []);
    const key = names.map(normName).join('|');
    const level = useMemo<SourcePrefUiLevel>(() => {
        const wanted = new Set(key ? key.split('|') : []);
        let more = false;
        for (const row of rows) {
            if (row.scopeKind != null || !wanted.has(normName(row.publicationName))) continue;
            if (row.weight < 0) return 'deprioritised';
            if (row.weight > 0) more = true;
        }
        return more ? 'prioritised' : 'none';
    }, [rows, key]);
    const change = useCallback(
        (next: SourcePrefUiLevel) => {
            const targets = key ? key.split('|') : [];
            if (targets.length === 0) return;
            setBusy(true);
            void (async () => {
                try {
                    for (const publicationName of names) {
                        await setSourcePrefFromUi({ kind: 'publication', publicationName }, next);
                    }
                } catch (error) {
                    logger.captureException(error, { tags: { screen: 'PublicationPage', method: 'setPref' } });
                } finally {
                    setBusy(false);
                }
            })();
        },
        // `key` stands in for `names`, whose identity changes every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key],
    );
    return { level, busy, change };
}
