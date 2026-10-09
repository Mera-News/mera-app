import { useSubscribeFlow } from '@/components/custom/publication-preferences/use-subscribe-flow';
import { getCountryName } from '@/lib/country-utils';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import { getLocalizedLanguageName } from '@/lib/language-names';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { calendarDaysAgo, formatDayMonth } from '@/lib/stats/visited-publications';
import { toastManager } from '@/lib/toast-manager';
import { router } from 'expo-router';
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { FlatList } from 'react-native';

import {
    publicationKeysFor,
    type PublicationOrder,
    type PublicationView,
} from './open-publication-page';
import {
    usePublicationArticles,
    usePublicationHistory,
    usePublicationPref,
    usePublicationProfile,
    type PublicationProfileKey,
} from './publication-data';
import { visitedToNewsArticle } from './visited-article';
import { formatCategories, sourceKindOf } from './publication-format';

export function usePublicationPage({
    publisherId,
    rawName,
    countryCode,
    order,
    focused,
}: {
    publisherId?: string | null;
    rawName?: string | null;
    countryCode?: string | null;
    order: PublicationView;
    focused: boolean;
}) {
    const { t, i18n } = useTranslation();
    const listRef = useRef<FlatList<NewsArticle>>(null);

    const key = useMemo<PublicationProfileKey | null>(() => {
        if (publisherId) return { publisherId };
        if (rawName) return { rawName, countryCode: countryCode ?? null };
        return null;
    }, [publisherId, rawName, countryCode]);
    const { state, profile, retry } = usePublicationProfile(key);

    const newsPublisherId = publisherId || profile?.newsPublisherId || null;

    // More/fewer, keyed on every name the publication is known by. Resolved
    // from what the device knows, so it works offline and when not found.
    const pref = usePublicationPref({
        publisherId: newsPublisherId,
        rawName,
        publisherName: profile?.name,
        sourceNames: profile?.sourceNames,
    });

    // The news starts as soon as a publisher id is known and does not wait on
    // the profile. An unknown publication gets none. So does a server too old
    // for the profile query, UNLESS the page was opened by publisher id: that
    // server still answers `articlesForPublisher` (as Top headlines; the
    // switch then shows only that tab, see `shownOrder`).
    const newsAvailable = state !== 'notFound' && !(state === 'unsupported' && !newsPublisherId);
    // History is not a news order: under it the news stays requested as Latest,
    // so switching back to Latest is instant.
    const newsOrder: PublicationOrder = order === 'HISTORY' ? 'NEWEST' : order;
    const news = usePublicationArticles(newsAvailable ? newsPublisherId : null, newsOrder, {
        sourceNames: profile?.sourceNames ?? pref.names,
    });
    // An older server answers a Latest request with Top headlines. The switch
    // must not claim Latest then.
    const shownOrder: PublicationOrder = newsOrder === 'NEWEST' && !news.orderApplied ? 'TOP_HEADLINES' : newsOrder;

    // Display: the profile's name in the app language, else the display-store
    // name for the raw key. Every write and lookup keeps the RAW names.
    const shownFromStore = useDisplayPublication((profile?.name ?? rawName ?? '').trim());
    const displayName = profile?.displayName?.trim() || shownFromStore || profile?.name || rawName || '';
    const showPref = pref.names.length > 0 || !!rawName?.trim();

    const onTopKeys = useMemo(
        () => [
            ...publicationKeysFor({ publisherId: newsPublisherId, rawName, countryCode }),
            ...publicationKeysFor({ rawName: profile?.name, countryCode: profile?.countryCode ?? countryCode }),
        ],
        [newsPublisherId, rawName, countryCode, profile?.name, profile?.countryCode],
    );

    const subscribeFlow = useSubscribeFlow();
    const openArticle = useOpenArticle();

    // History: the reader's visits to this publication, matched on every
    // name it is known by. Read whenever the page is focused (one local
    // read): the support box's "opened N times" sums the same rows, so it
    // always agrees with this list. A visit recorded while away shows on
    // return.
    const isHistory = order === 'HISTORY';
    const historyNames = useMemo(
        () =>
            [rawName, profile?.name, ...(profile?.sourceNames ?? []), ...pref.names].filter(
                (n): n is string => typeof n === 'string' && n.trim() !== '',
            ),
        [rawName, profile?.name, profile?.sourceNames, pref.names],
    );
    const history = usePublicationHistory(historyNames, focused);
    // Raw visits (taps), summed over every name: the History table's noun.
    const visitCount = useMemo(
        () => history.visits.reduce((sum, v) => sum + Math.max(1, v.visitCount || 0), 0),
        [history.visits],
    );
    // A visit row without an article id cannot open the detail screen (its
    // URL is not an id), so it renders but its tap does nothing.
    const openableHistoryIds = useMemo(
        () => new Set(history.visits.map((v) => v.articleId).filter((id): id is string => !!id)),
        [history.visits],
    );

    const selectOrder = useCallback(
        (next: PublicationView) => {
            if (next === order) return;
            // setParams, never push: Back must leave the page, not step
            // through the reader's tab switches.
            // An explicit NEWEST rather than clearing the param: the route maps
            // anything but TOP_HEADLINES to Latest, and this does not depend on
            // how the router treats an undefined param.
            router.setParams({ order: next });
            listRef.current?.scrollToOffset({ offset: 0, animated: false });
        },
        [order],
    );

    // ── Header pieces ────────────────────────────────────────────────────
    const country = profile?.countryCode ?? countryCode ?? null;
    const countryLabel =
        profile?.countryName || (country && country !== 'GLOBAL' ? getCountryName(country) : null) || null;
    const languageLabels = (profile?.languages ?? [])
        .map((code) => getLocalizedLanguageName(code, i18n?.language ?? 'en'))
        .filter((l): l is string => !!l);
    const dataLine = [countryLabel, ...languageLabels, formatCategories(profile?.categories)]
        .filter(Boolean)
        .join(' · ');
    const kind = profile?.isOfficial ? sourceKindOf(profile.publicationType) ?? 'regulator' : null;

    // A subscription is keyed on the publisher id; the outlet's own subscribe
    // page is optional (only the Subscribe link below needs it).
    const subscribeTarget = profile?.newsPublisherId
        ? {
              publisherId: profile.newsPublisherId,
              publisherName: profile.name,
              countryCode: profile.countryCode,
              subscriptionUri: profile.subscriptionUri ?? null,
          }
        : null;
    const subscribed = subscribeTarget ? subscribeFlow.isSubscribed(subscribeTarget.publisherId) : false;
    const subscriptionRow = subscribeTarget
        ? subscribeFlow.subscriptions.items.find((r) => r.publisherId === subscribeTarget.publisherId)
        : undefined;
    // An add marks the publisher id busy, a remove the row id.
    const busySubscriptionId = subscribeFlow.subscriptions.busyId;
    const subscribeBusy =
        !!subscribeTarget &&
        !!busySubscriptionId &&
        (busySubscriptionId === subscribeTarget.publisherId || busySubscriptionId === subscriptionRow?.id);
    const toggleSubscribed = () => {
        if (!subscribeTarget) return;
        const row = subscriptionRow;
        if (!row) {
            void subscribeFlow.confirmDirectly(subscribeTarget);
            return;
        }
        void subscribeFlow.subscriptions.removeSubscription(row).then((ok) => {
            if (ok) toastManager.showInfo(t('subscriptions.removed', { publisher: row.publisherName }));
        });
    };

    const historyArticles = useMemo(() => history.visits.map(visitedToNewsArticle), [history.visits]);
    // A History row says when the READER opened it (FinalLibrary #15), not
    // the publish age: "Opened today", "Opened yesterday", "Opened 4 Oct".
    const openedLabelById = useMemo(() => {
        const now = Date.now();
        const out = new Map<string, string>();
        for (const v of history.visits) {
            const id = v.articleId ?? v.articleUrl;
            if (!id) continue;
            const days = calendarDaysAgo(v.visitedAt, now);
            out.set(
                id,
                days <= 0
                    ? t('publicationPage.openedToday')
                    : days === 1
                      ? t('publicationPage.openedYesterday')
                      : t('publicationPage.openedOn', { date: formatDayMonth(v.visitedAt, i18n?.language) }),
            );
        }
        return out;
    }, [history.visits, t, i18n?.language]);
    const articles: NewsArticle[] = isHistory ? historyArticles : newsAvailable ? news.articles : [];

    const onEndReached = useCallback(() => {
        if (isHistory) return;
        if (news.hasMore && news.state === 'ready' && news.loadMoreState === 'idle') news.loadMore();
    }, [news, isHistory]);

    const onRefresh = useCallback(() => {
        if (state === 'error' || state === 'offline') retry();
        if (isHistory) history.reload();
        else if (newsAvailable) void news.refresh();
    }, [state, retry, isHistory, history, newsAvailable, news]);

    return {
        listRef,
        state,
        retry,
        profile,
        newsPublisherId,
        pref,
        newsAvailable,
        news,
        shownOrder,
        displayName,
        showPref,
        onTopKeys,
        subscribeFlow,
        openArticle,
        isHistory,
        history,
        visitCount,
        openableHistoryIds,
        selectOrder,
        dataLine,
        kind,
        subscribeTarget,
        subscribed,
        subscribeBusy,
        toggleSubscribed,
        openedLabelById,
        articles,
        onEndReached,
        onRefresh,
    };
}
