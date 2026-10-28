import DrillDownHeader, { SUBPAGE_TOP_GAP } from '@/components/custom/config-panel/DrillDownHeader';
import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import SubscribeConfirmDialog from '@/components/custom/publication-preferences/SubscribeConfirmDialog';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import { useColors } from '@/lib/theme/tokens';
import { useReportRestoredScreen } from '@/lib/navigation/use-restore-state';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type ListRenderItem, Platform, RefreshControl, StyleSheet, View } from 'react-native';

import PublicationFeedControl from './PublicationFeedControl';
import PublicationHeader from './PublicationHeader';
import { setPublicationOnTop, type PublicationView } from './open-publication-page';
import { usePublicationPage } from './usePublicationPage';
import { SOURCE_KIND_META } from './publication-format';


/** The page body's vertical rhythm, in points (NativeWind space tokens are
 *  rem-scaled at 14pt, so plain numbers keep this exact). Identity, then the
 *  reader's controls, then a hairline and the news. */
const PAGE_SPACING = {
    top: SUBPAGE_TOP_GAP,
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
const PILL_FRAME_PAD = 5;

interface PublicationPageProps {
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
 * publication, Subscribe, then three sub-tabs: its news (Latest or Top
 * headlines) and History, the reader's own visits to it in the last 30 days.
 * One FlatList; everything above the list is its header.
 *
 * Opened by a publisher id or by a raw name plus country, never by a feed id.
 * The news request starts as soon as a publisher id is known and does not
 * wait on the profile.
 */
/**
 * FinalLibrary #14: how often the reader opened this outlet, why support
 * matters, then Subscribe, which opens the outlet's own subscribe page and asks
 * on return. Shown only when the outlet has a subscription page and the reader
 * has not tagged it Subscribed (the tag grid above marks a subscription the
 * reader already has). ponytail: Subscribe only; the board's "Support" for
 * donation-funded outlets needs a catalogue field that does not exist (owner
 * default L2).
 */
const SupportBox: React.FC<{
    readonly displayName: string;
    readonly visitCount: number;
    readonly onSubscribe: () => void;
}> = ({ displayName, visitCount, onSubscribe }) => {
    const { t } = useTranslation();
    const c = useColors();
    const line = { color: c.ink2, lineHeight: 20 } as const;
    return (
        <View style={[styles.supportBox, { backgroundColor: c.surface, borderColor: c.line }]} testID="publication-support">
            <Text size="sm" style={line}>
                {visitCount > 0
                    ? `${t('publicationPage.openedCount', { count: visitCount, publisher: displayName })} `
                    : ''}
                {t('publicationPage.supportLine')}
            </Text>
            <Pressable
                onPress={onSubscribe}
                accessibilityRole="button"
                accessibilityLabel={t('subscriptions.subscribeAt', { publisher: displayName })}
                accessibilityHint={t('subscriptions.opensPublisherSite', { publisher: displayName })}
                testID="publication-subscribe"
                style={[styles.supportButton, { backgroundColor: c.accent }]}
            >
                <Text size="sm" style={{ color: c.onAccent, fontWeight: '600' }}>
                    {t('subscriptions.subscribeAt', { publisher: displayName })}
                </Text>
            </Pressable>
        </View>
    );
};

const PublicationPage: React.FC<PublicationPageProps> = ({ publisherId, rawName, countryCode, order, onBack }) => {
    const { t } = useTranslation();
    const focused = useIsFocusedSafe();
    const colors = useColors();
    const {
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
    } = usePublicationPage({ publisherId, rawName, countryCode, order, focused });
    // Missing only for a publisher-id lookup the server answered "not found";
    // a page opened by name and an 'unsupported' answer are ready.
    useReportRestoredScreen(
        state === 'loading' ? 'loading' : publisherId && state === 'notFound' ? 'missing' : 'ready',
    );

    // Register this publication as the one on top while focused, so an entry
    // point inside the page (a card's source name in its own list) does not
    // stack a second copy.
    useFocusEffect(
        useCallback(() => {
            setPublicationOnTop(onTopKeys);
            return () => setPublicationOnTop([]);
        }, [onTopKeys]),
    );

    const roles = switchRoles(Platform.OS);
    const pill = (value: PublicationView, label: string, testID: string) => {
        const selected = isHistory ? value === 'HISTORY' : shownOrder === value;
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
                        backgroundColor: selected ? colors.accent : 'transparent',
                        borderWidth: selected ? 0 : 1,
                        borderColor: colors.line,
                    }}
                >
                    <Text size="sm" style={{ color: selected ? colors.onAccent : colors.ink, fontWeight: '600' }}>
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
                badge={kind ? { label: t(SOURCE_KIND_META[kind].key), color: colors[SOURCE_KIND_META[kind].color] } : null}
                detailsLoading={state === 'loading'}
            />

            {showPref ? (
                <PublicationFeedControl
                    testID="publication-pref-row"
                    current={pref.level}
                    muted={pref.muted}
                    subscribed={subscribed}
                    canSubscribe={!!subscribeTarget}
                    subscribeBusy={subscribeBusy}
                    onToggleSubscribed={toggleSubscribed}
                    busy={pref.busy || pref.names.length === 0}
                    onChange={pref.change}
                />
            ) : null}

            {state === 'offline' ? (
                <Text size="sm" style={{ color: colors.ink3 }} testID="publication-offline">
                    {t('publicationPage.offlineHint')}
                </Text>
            ) : null}

            {state === 'notFound' ? (
                <Text size="sm" style={{ color: colors.ink3 }} testID="publication-not-found">
                    {t('publicationPage.notFound')}
                </Text>
            ) : null}

            {state === 'error' ? (
                <HStack space="md" className="items-center" testID="publication-error">
                    <Text size="sm" className="text-ink flex-1">
                        {t('publicationPage.loadError')}
                    </Text>
                    <Pressable
                        testID="publication-error-retry"
                        onPress={retry}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.retry')}
                        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}
                    >
                        <Text size="sm" className="text-ink font-semibold underline">
                            {t('common.retry')}
                        </Text>
                    </Pressable>
                </HStack>
            ) : null}

            {subscribeTarget?.subscriptionUri && !subscribed ? (
                <SupportBox
                    displayName={displayName}
                    visitCount={visitCount}
                    onSubscribe={() => void subscribeFlow.begin(subscribeTarget)}
                />
            ) : null}

            {/* A hairline above the switch: what the reader can do with the
                outlet ends here, and its lists begin. History is always
                offered: the reader's own visits need no server. */}
            <HStack
                space="sm"
                className="items-center"
                accessibilityRole={roles.row}
                testID="publication-order-switch"
                // Wraps rather than clips if a locale's three labels outgrow
                // the row.
                style={{
                    flexWrap: 'wrap',
                    borderTopWidth: StyleSheet.hairlineWidth,
                    borderTopColor: colors.line,
                    paddingTop: PAGE_SPACING.switchTop,
                    marginTop: PAGE_SPACING.sectionGap - PAGE_SPACING.blockGap,
                }}
            >
                {newsAvailable && news.orderApplied
                    ? pill('NEWEST', t('publicationPage.latest'), 'publication-order-latest')
                    : null}
                {newsAvailable ? pill('TOP_HEADLINES', t('sources.topHeadlines'), 'publication-order-top') : null}
                {pill('HISTORY', t('publicationPage.history'), 'publication-order-history')}
            </HStack>
            {isHistory ? (
                <Text size="sm" style={{ color: colors.ink3, marginTop: -12 }} testID="publication-history-label">
                    {t('publicationPage.visitsLabel')}
                </Text>
            ) : null}
        </View>
    );

    // ── The list: news, or History ───────────────────────────────────────
    const renderItem: ListRenderItem<NewsArticle> = useCallback(
        ({ item }) => (
            <ArticleStandaloneCompactCard
                article={item}
                timeLabel={isHistory ? openedLabelById.get(item._id) : undefined}
                onPress={() => {
                    if (isHistory && !openableHistoryIds.has(item._id)) return;
                    openArticle({ articleId: item._id });
                }}
                subjectExtras={{ surface: 'detail' }}
            />
        ),
        [openArticle, isHistory, openableHistoryIds, openedLabelById],
    );

    let listEmpty: React.ReactElement | null = null;
    if (isHistory) {
        listEmpty =
            history.state === 'loading' ? (
                <Box className="items-center py-8" testID="publication-history-loading">
                    <Spinner size="small" />
                </Box>
            ) : (
                <Text size="sm" className="py-6" style={{ color: colors.ink3, lineHeight: 20 }} testID="publication-history-empty">
                    {t('publicationPage.historyEmpty')}
                </Text>
            );
    } else if (newsAvailable && (newsPublisherId || news.state === 'offline')) {
        if (news.state === 'idle' || news.state === 'loading') {
            listEmpty = (
                <Box className="items-center py-8" testID="publication-news-loading">
                    <Spinner size="small" />
                </Box>
            );
        } else if (news.state === 'error') {
            listEmpty = (
                <VStack space="sm" className="items-center py-8 px-6" testID="publication-news-error">
                    <Text size="sm" className="text-ink text-center">
                        {t('publicationPage.newsLoadError')}
                    </Text>
                    <Pressable
                        testID="publication-news-retry"
                        onPress={() => void news.refresh()}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.retry')}
                        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 }}
                    >
                        <Text size="sm" className="text-ink font-semibold underline">
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
                            backgroundColor: colors.surface,
                        }}
                    >
                        <MaterialIcons name="article" size={22} color={colors.ink3} />
                    </View>
                    <Text size="sm" className="text-center" style={{ color: colors.ink3, lineHeight: 20 }}>
                        {shownOrder === 'TOP_HEADLINES'
                            ? t('publicationPage.noTopHeadlines')
                            : t('publicationPage.noLatest')}
                    </Text>
                </VStack>
            );
        }
    }

    let listFooter: React.ReactElement | null = null;
    if (isHistory) {
        listFooter = null;
    } else if (articles.length > 0 && news.loadMoreState === 'loading') {
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
                    <Text size="sm" className="text-ink font-semibold underline">
                        {t('common.retry')}
                    </Text>
                </Pressable>
            </Box>
        );
    }


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
            <View style={{ flex: 1 }}>
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
                        refreshing={isHistory ? false : news.refreshing}
                        onRefresh={onRefresh}
                        tintColor={colors.accent}
                    />
                }
            />
            </View>
            <SubscribeConfirmDialog
                publisherName={subscribeFlow.confirming?.publisherName ?? null}
                onYes={subscribeFlow.onYes}
                onNo={subscribeFlow.onNo}
                onDismiss={subscribeFlow.onDismiss}
            />
        </Box>
    );
};

const styles = StyleSheet.create({
    supportBox: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 12 },
    supportButton: { minHeight: 44, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
});

export default PublicationPage;
