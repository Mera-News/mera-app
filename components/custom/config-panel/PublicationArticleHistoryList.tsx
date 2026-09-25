import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import SubscribeAction from '@/components/custom/publication-preferences/SubscribeAction';
import SubscribeConfirmDialog from '@/components/custom/publication-preferences/SubscribeConfirmDialog';
import { useSubscribeFlow } from '@/components/custom/publication-preferences/use-subscribe-flow';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    getVisitsForPublication,
    type VisitedArticle,
} from '@/lib/database/services/publication-visit-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import logger from '@/lib/logger';
import {
    resolvePublisherForSourceName,
    type ResolvedPublisher,
} from '@/lib/subscriptions/publisher-lookup';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, RefreshControl } from 'react-native';
import DrillDownHeader from './DrillDownHeader';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { notifyScrollTick } from '@/lib/visibility-tick';

interface Props {
    readonly publicationName: string;
    readonly countryCode: string | null;
    readonly onBack: () => void;
}

const visitedToNewsArticle = (v: VisitedArticle): NewsArticle =>
    ({
        _id: v.articleId ?? v.articleUrl ?? '',
        title: v.titleOriginal ?? v.titleEn ?? '',
        title_en_internal_only: v.titleEn ?? undefined,
        pubDate: v.pubDate != null ? new Date(v.pubDate).toISOString() : '',
        image_url: v.imageUrl ?? undefined,
        article_url: v.articleUrl ?? undefined,
        original_language_code: v.languageCode ?? undefined,
        publicationSource:
            v.publicationName || v.countryCode
                ? ({
                      _id: v.articleId ?? v.articleUrl ?? '',
                      publication_name: v.publicationName,
                      country_code: v.countryCode,
                  } as NewsArticle['publicationSource'])
                : undefined,
    }) as NewsArticle;

const PublicationArticleHistoryList: React.FC<Props> = ({
    publicationName,
    countryCode,
    onBack,
}) => {
    const { t } = useTranslation();
    // Display only: the visits below are looked up by the raw name.
    const publicationShown = useDisplayPublication(publicationName);
    const [items, setItems] = useState<VisitedArticle[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const hasFetched = useRef(false);

    const load = useCallback(async () => {
        try {
            const rows = await getVisitsForPublication(publicationName, countryCode);
            setItems(rows);
        } catch (error) {
            logger.captureException(error, {
                tags: {
                    screen: 'PublicationArticleHistoryList',
                    method: 'load',
                },
                extra: { publicationName, countryCode },
            });
        }
    }, [publicationName, countryCode]);

    useEffect(() => {
        if (!hasFetched.current) {
            hasFetched.current = true;
            setIsLoading(true);
            load().finally(() => setIsLoading(false));
        }
    }, [load]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    // ---------------------------------------------------------------
    // Subscribing to the PUBLISHER, from the screen where the reader is
    // already looking at how much of this publication they read.
    //
    // This screen is backed by the local `publication_visits` table and makes
    // no GraphQL call of its own, so all it holds is a SOURCE name and a
    // country. `resolvePublisherForSourceName` turns that into a publisher
    // and its own subscribe page, exactly once per session per name, and
    // returns null rather than guessing. Everything below is gated on a real
    // resolved URI, so a publication with no consumer subscription product,
    // or one the catalogue does not know, renders this screen exactly as it
    // rendered before.
    // ---------------------------------------------------------------
    const [publisher, setPublisher] = useState<ResolvedPublisher | null>(null);
    const { begin, confirmDirectly, confirming, onYes, onNo, onDismiss, isSubscribed } =
        useSubscribeFlow();

    useEffect(() => {
        let cancelled = false;
        void resolvePublisherForSourceName(publicationName, countryCode).then((resolved) => {
            if (!cancelled) setPublisher(resolved);
        });
        return () => {
            cancelled = true;
        };
    }, [publicationName, countryCode]);

    // Three conditions, all required. No resolved publisher and no URI both
    // mean there is nowhere honest to send anybody. An ACTIVE subscription
    // means the reader has already answered this question, so the block is
    // hidden rather than greyed: managing a subscription belongs on the
    // settings screen, and a disabled control here would just be clutter the
    // reader cannot act on.
    const offerSubscribe =
        publisher != null &&
        publisher.subscriptionUri != null &&
        !isSubscribed(publisher.publisherId);

    // Deliberately carries NO count of articles read. `getVisitsForPublication`
    // dedupes its rows, so `items.length` is distinct ARTICLES, while the one
    // existing string for this shape (`publicationVisits.badge`) says
    // "visited {{count}} times" and would therefore be a false claim in both
    // the noun and the number. The list below is the evidence; it does not
    // need a headline number, and it does not get an invented one.
    const ListHeader =
        offerSubscribe && publisher ? (
            <Box className="mx-4 mt-3 mb-1 p-4 rounded-lg border border-gray-700">
                <SubscribeAction
                    publisherName={publisher.publisherName}
                    variant="card"
                    testID="publication-history-subscribe"
                    onOpen={() => void begin(publisher)}
                    onAlready={() => void confirmDirectly(publisher)}
                />
            </Box>
        ) : null;

    // History rows go to the DETAIL screen, never straight to the publisher.
    // This list used to open the article URL on tap, which skipped the only
    // screen carrying the translate affordance — the reader landed on a page in
    // a language they may not read with no way back to the translate options.
    //
    // An article older than the server's 48h TTL still works: article-detail
    // falls back to this very visit row's snapshot (see
    // `getVisitedArticleById`), so the read/translate block is always reachable.
    //
    // `articleId` is nullable on the ROW but not in practice: every current
    // caller of `recordPublicationVisit` passes one, and the column has been
    // written since migration v22 — far outside the 30-day prune window. A row
    // without one is inert rather than dead-ending: `articleUrl` is not an
    // article id, and routing it as one would pollute the saved/visit tables,
    // which key off that param.
    const openArticle = useOpenArticle();
    const handleArticlePress = useCallback(
        (articleId: string | null) => {
            if (!articleId) return;
            openArticle({ articleId });
        },
        [openArticle],
    );

    const keyExtractor = useCallback(
        (item: VisitedArticle, index: number) =>
            item.articleId ?? item.articleUrl ?? `visit-${index}`,
        [],
    );

    const renderItem: ListRenderItem<VisitedArticle> = useCallback(
        ({ item }) => (
            <Box className="mx-4">
                <ArticleStandaloneCompactCard
                    article={visitedToNewsArticle(item)}
                    onPress={() => handleArticlePress(item.articleId)}
                    subjectExtras={{ surface: 'detail' }}
                />
            </Box>
        ),
        [handleArticlePress],
    );

    return (
        // No opaque fill: the route mounts AbstractGradientBackdrop OUTSIDE
        // its SafeAreaView, so the page background spans the safe areas.
        <Box className="flex-1">
            <DrillDownHeader
                title={publicationShown}
                subtitle={t('publicationVisits.articlesRead')}
                onBack={onBack}
            />
            {isLoading ? (
                <Box className="flex-1 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            ) : items.length === 0 ? (
                <VStack className="flex-1 items-center justify-center p-6" space="md">
                    <MaterialIcons name="article" size={48} color="#666666" />
                    <Text size="md" className="text-gray-400 text-center">
                        {t('publicationVisits.noArticlesLast30Days')}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    // Rows below the first screen ask for their translation only
                    // when a scroll tick finds them on screen (lib/visibility-tick).
                    onScroll={notifyScrollTick}
                    scrollEventThrottle={16}
                    onContentSizeChange={notifyScrollTick}
                    data={items}
                    renderItem={renderItem}
                    keyExtractor={keyExtractor}
                    ListHeaderComponent={ListHeader}
                    contentContainerStyle={{ paddingTop: 12, paddingBottom: 20 }}
                    showsVerticalScrollIndicator={false}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            tintColor="#ffffff"
                            colors={['#ffffff']}
                        />
                    }
                />
            )}

            {/* Asked on return from the publisher's page. Rendered outside
                both list branches so a confirm armed before a refresh that
                emptied the list still has somewhere to appear. */}
            <SubscribeConfirmDialog
                publisherName={confirming?.publisherName ?? null}
                onYes={onYes}
                onNo={onNo}
                onDismiss={onDismiss}
            />
        </Box>
    );
};

export default PublicationArticleHistoryList;
