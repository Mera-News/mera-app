import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import SubscribeAction from '@/components/custom/publication-preferences/SubscribeAction';
import SubscribeConfirmDialog from '@/components/custom/publication-preferences/SubscribeConfirmDialog';
import { useSubscribeFlow } from '@/components/custom/publication-preferences/use-subscribe-flow';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getCountryName } from '@/lib/country-utils';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import { getLocalizedLanguageName } from '@/lib/language-names';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type ListRenderItem, Platform, RefreshControl, StyleSheet, View } from 'react-native';

import PublicationFeedControl from './PublicationFeedControl';
import PublicationHeader from './PublicationHeader';
import {
    publicationKeysFor,
    setPublicationOnTop,
    type PublicationOrder,
    type PublicationView,
} from './open-publication-page';
import {
    usePublicationArticles,
    usePublicationPref,
    usePublicationProfile,
    type PublicationProfileKey,
} from './publication-data';
import { formatCategories, SOURCE_KIND_META, sourceKindOf } from './publication-format';

const MUTED = 'rgb(156,163,175)';
const DIVIDER = 'rgba(255,255,255,0.10)';

/** The page body's vertical rhythm, in points (NativeWind space tokens are
 *  rem-scaled at 14pt, so plain numbers keep this exact). Identity, then the
 *  reader's controls, then a hairline and the news. */
export const PAGE_SPACING = {
    top: 20,
    blockGap: 24,
    sectionGap: 28,
    switchTop: 16,
    bottom: 12,
} as const;

const PAGE_HEADER_STYLE = {
    paddingTop: PAGE_SPACING.top,
    paddingBottom: PAGE_SPACING.bottom,
    gap: PAGE_SPACING.blockGap,
} as const;
const PILL_ACTIVE_FILL = 'rgb(96,165,250)';
const PILL_FRAME_PAD = 5;

export interface PublicationPageProps {
    readonly publisherId?: string | null;
    /** The raw publication name the entry point had (never a display name). */
    readonly rawName?: string | null;
    readonly countryCode?: string | null;
    readonly order: PublicationView;
    readonly onBack: () => void;
}

/** Same mapping as the Dashboard pills (`for-you/ForYouSubTabs.tsx`):
 *  `accessibilityRole="tab"` maps to no trait on iOS, so a pill there is a
 *  button inside a tabbar; Android gets tab inside tablist. */
function switchRoles(os: string): { row: 'tabbar' | 'tablist'; pill: 'button' | 'tab' } {
    return os === 'ios' ? { row: 'tabbar', pill: 'button' } : { row: 'tablist', pill: 'tab' };
}

/**
 * The publication page: identity, more/fewer, what we know about the
 * publication, Subscribe, then its news (Latest or Top headlines). One
 * FlatList; everything above the news is its header.
 *
 * Opened by a publisher id or by a raw name plus country, never by a feed id.
 * The news request starts as soon as a publisher id is known and does not
 * wait on the profile.
 */
const PublicationPage: React.FC<PublicationPageProps> = ({ publisherId, rawName, countryCode, order, onBack }) => {
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

    // Register this publication as the one on top while focused, so an entry
    // point inside the page (a card's source name in its own list) does not
    // stack a second copy.
    const onTopKeys = useMemo(
        () => [
            ...publicationKeysFor({ publisherId: newsPublisherId, rawName, countryCode }),
            ...publicationKeysFor({ rawName: profile?.name, countryCode: profile?.countryCode ?? countryCode }),
        ],
        [newsPublisherId, rawName, countryCode, profile?.name, profile?.countryCode],
    );
    useFocusEffect(
        useCallback(() => {
            setPublicationOnTop(onTopKeys);
            return () => setPublicationOnTop([]);
        }, [onTopKeys]),
    );

    const subscribeFlow = useSubscribeFlow();
    const openArticle = useOpenArticle();

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

    const subscribeTarget =
        profile?.subscriptionUri && profile.newsPublisherId
            ? {
                  publisherId: profile.newsPublisherId,
                  publisherName: profile.name,
                  countryCode: profile.countryCode,
                  subscriptionUri: profile.subscriptionUri,
              }
            : null;
    const subscribed = subscribeTarget ? subscribeFlow.isSubscribed(subscribeTarget.publisherId) : false;

    const roles = switchRoles(Platform.OS);
    const pill = (value: PublicationOrder, label: string, testID: string) => {
        const selected = shownOrder === value;
        return (
            <Pressable
                key={value}
                testID={testID}
                onPress={() => selectOrder(value)}
                accessibilityRole={roles.pill}
                accessibilityLabel={label}
                accessibilityState={{ selected }}
                style={{ paddingVertical: PILL_FRAME_PAD }}
            >
                <View
                    style={{
                        minHeight: 34,
                        paddingHorizontal: 14,
                        borderRadius: 999,
                        justifyContent: 'center',
                        backgroundColor: selected ? PILL_ACTIVE_FILL : 'transparent',
                        borderWidth: selected ? 0 : 1,
                        borderColor: 'rgb(75,85,99)',
                    }}
                >
                    <Text size="sm" style={{ color: selected ? '#000000' : '#FFFFFF', fontWeight: '600' }}>
                        {label}
                    </Text>
                </View>
            </Pressable>
        );
    };

    const listHeader = (
        <View style={PAGE_HEADER_STYLE} testID="publication-page-header">
            <PublicationHeader
                displayName={displayName}
                homepageUrl={profile?.homepageUrl}
                details={dataLine || null}
                badge={kind ? { label: t(SOURCE_KIND_META[kind].key), color: SOURCE_KIND_META[kind].color } : null}
                detailsLoading={state === 'loading'}
            />

            {showPref ? (
                <PublicationFeedControl
                    testID="publication-pref-row"
                    current={pref.level}
                    busy={pref.busy || pref.names.length === 0}
                    onChange={pref.change}
                />
            ) : null}

            {state === 'offline' ? (
                <Text size="sm" style={{ color: MUTED }} testID="publication-offline">
                    {t('publicationPage.offlineHint')}
                </Text>
            ) : null}

            {state === 'notFound' ? (
                <Text size="sm" style={{ color: MUTED }} testID="publication-not-found">
                    {t('publicationPage.notFound')}
                </Text>
            ) : null}

            {state === 'error' ? (
                <HStack space="md" className="items-center" testID="publication-error">
                    <Text size="sm" className="text-white flex-1">
                        {t('publicationPage.loadError')}
                    </Text>
                    <Pressable
                        testID="publication-error-retry"
                        onPress={retry}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.retry')}
                        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}
                    >
                        <Text size="sm" className="text-white font-semibold underline">
                            {t('common.retry')}
                        </Text>
                    </Pressable>
                </HStack>
            ) : null}

            {subscribeTarget ? (
                subscribed ? (
                    <HStack space="xs" className="items-center" testID="publication-subscribed">
                        <MaterialIcons
                            name="check-circle"
                            size={14}
                            color="#10b981"
                            accessible={false}
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                        />
                        <Text size="sm" className="text-gray-300">
                            {t('publicationPage.subscribed', { publisher: displayName })}
                        </Text>
                    </HStack>
                ) : (
                    <SubscribeAction
                        publisherName={displayName}
                        variant="inline"
                        testID="publication-subscribe"
                        onOpen={() => void subscribeFlow.begin(subscribeTarget)}
                    />
                )
            ) : null}

            {newsAvailable ? (
                // A hairline above the switch: what the reader can do with the
                // outlet ends here, and its news begins.
                <HStack
                    space="sm"
                    className="items-center"
                    accessibilityRole={roles.row}
                    testID="publication-order-switch"
                    style={{
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: DIVIDER,
                        paddingTop: PAGE_SPACING.switchTop,
                        marginTop: PAGE_SPACING.sectionGap - PAGE_SPACING.blockGap,
                    }}
                >
                    {news.orderApplied ? pill('NEWEST', t('publicationPage.latest'), 'publication-order-latest') : null}
                    {pill('TOP_HEADLINES', t('sources.topHeadlines'), 'publication-order-top')}
                </HStack>
            ) : null}
        </View>
    );

    // ── News list ────────────────────────────────────────────────────────
    const articles: NewsArticle[] = newsAvailable ? news.articles : [];
    const renderItem: ListRenderItem<NewsArticle> = useCallback(
        ({ item }) => (
            <ArticleStandaloneCompactCard
                article={item}
                onPress={() => openArticle({ articleId: item._id })}
                subjectExtras={{ surface: 'detail' }}
            />
        ),
        [openArticle],
    );

    let listEmpty: React.ReactElement | null = null;
    if (newsAvailable && (newsPublisherId || news.state === 'offline')) {
        if (news.state === 'idle' || news.state === 'loading') {
            listEmpty = (
                <Box className="items-center py-8" testID="publication-news-loading">
                    <Spinner size="small" />
                </Box>
            );
        } else if (news.state === 'error') {
            listEmpty = (
                <VStack space="sm" className="items-center py-8 px-6" testID="publication-news-error">
                    <Text size="sm" className="text-gray-300 text-center">
                        {t('publicationPage.newsLoadError')}
                    </Text>
                    <Pressable
                        testID="publication-news-retry"
                        onPress={() => void news.refresh()}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.retry')}
                        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}
                    >
                        <Text size="sm" className="text-white font-semibold underline">
                            {t('common.retry')}
                        </Text>
                    </Pressable>
                </VStack>
            );
        } else {
            listEmpty = (
                <VStack space="md" className="items-center py-12 px-8" testID="publication-news-empty">
                    <View
                        accessible={false}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                        style={{
                            width: 48,
                            height: 48,
                            borderRadius: 24,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: 'rgba(255,255,255,0.06)',
                        }}
                    >
                        <MaterialIcons name="article" size={22} color={MUTED} />
                    </View>
                    <Text size="sm" className="text-center" style={{ color: MUTED, lineHeight: 20 }}>
                        {shownOrder === 'TOP_HEADLINES'
                            ? t('publicationPage.noTopHeadlines')
                            : t('publicationPage.noLatest')}
                    </Text>
                </VStack>
            );
        }
    }

    let listFooter: React.ReactElement | null = null;
    if (articles.length > 0 && news.loadMoreState === 'loading') {
        listFooter = (
            <Box className="items-center py-4" testID="publication-news-loading-more">
                <Spinner size="small" />
            </Box>
        );
    } else if (articles.length > 0 && news.loadMoreState === 'error') {
        listFooter = (
            <Box className="items-center py-2" testID="publication-news-more-error">
                <Pressable
                    testID="publication-news-more-retry"
                    onPress={news.loadMore}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.retry')}
                    style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}
                >
                    <Text size="sm" className="text-white font-semibold underline">
                        {t('common.retry')}
                    </Text>
                </Pressable>
            </Box>
        );
    }

    const onEndReached = useCallback(() => {
        if (news.hasMore && news.state === 'ready' && news.loadMoreState === 'idle') news.loadMore();
    }, [news]);

    const onRefresh = useCallback(() => {
        if (state === 'error' || state === 'offline') retry();
        if (newsAvailable) void news.refresh();
    }, [state, retry, newsAvailable, news]);

    return (
        <Box className="flex-1" testID="publication-page">
            <DrillDownHeader
                title={displayName}
                // Back only: the identity lives in the page body, where it has
                // room (it overflowed the bar). An empty View rather than no
                // titleContent, which would draw the name a second time.
                titleContent={<View />}
                onBack={onBack}
                backTestID="publication-back"
            />
            <FlatList
                ref={listRef}
                data={articles}
                renderItem={renderItem}
                keyExtractor={(item, index) => item._id || `article-${index}`}
                ListHeaderComponent={listHeader}
                ListEmptyComponent={listEmpty}
                ListFooterComponent={listFooter}
                contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
                showsVerticalScrollIndicator={false}
                onScroll={notifyScrollTick}
                onContentSizeChange={notifyScrollTick}
                scrollEventThrottle={16}
                onEndReached={onEndReached}
                onEndReachedThreshold={0.5}
                refreshControl={
                    <RefreshControl
                        refreshing={news.refreshing}
                        onRefresh={onRefresh}
                        tintColor="#FFFFFF"
                    />
                }
            />
            <SubscribeConfirmDialog
                publisherName={subscribeFlow.confirming?.publisherName ?? null}
                onYes={subscribeFlow.onYes}
                onNo={subscribeFlow.onNo}
                onDismiss={subscribeFlow.onDismiss}
            />
        </Box>
    );
};

export default PublicationPage;
