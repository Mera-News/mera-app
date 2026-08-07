import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { alpha2ToAlpha3 } from '@/lib/explore/scopes';
import type { NewsSearchHit } from '@/lib/generated/graphql-types';
import type { NewsSearchErrorKind } from '@/lib/news-search/search-news-service';
import type { NewsSearchStatus } from '@/lib/news-search/use-news-search';
import { presentFreeTierPaywall } from '@/lib/subscription/present-free-tier-paywall';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type ListRenderItem } from 'react-native';

interface ExploreSearchResultsProps {
    readonly status: NewsSearchStatus;
    readonly hits: NewsSearchHit[];
    readonly errorKind: NewsSearchErrorKind | null;
    readonly onPressHit: (hit: NewsSearchHit) => void;
    readonly onRetry: () => void;
}

/**
 * Explore's search results panel (Item 12a) — mounted by ExploreScreen only
 * while a search is active (query non-empty), overlaid on top of the normal
 * scope list rather than replacing it, so the scope chips/list underneath are
 * never disturbed and reappear exactly as they were once the query clears.
 *
 * Rendered purely off `useNewsSearch`'s status:
 *   - 'idle'    → the query hasn't reached the server's 2-char floor yet.
 *   - 'loading' → debounce settled, fetch in flight.
 *   - 'error'   → 402 (`not-subscribed`) gets its own "needs a plan" message
 *                 + a paywall entry point; anything else is a generic retry.
 *   - 'success' with zero hits → a gentle empty state — `searchNews` is a
 *     semantic search over the last 48h, not the full archive, so "no
 *     articles found" would overstate what was actually searched.
 *   - 'success' with hits → the results themselves, one compact row each.
 */
const ExploreSearchResults: React.FC<ExploreSearchResultsProps> = ({
    status,
    hits,
    errorKind,
    onPressHit,
    onRetry,
}) => {
    const { t } = useTranslation();

    const handleSeePlans = useCallback(() => {
        void presentFreeTierPaywall('explore-search');
    }, []);

    const renderItem: ListRenderItem<NewsSearchHit> = useCallback(
        ({ item }) => (
            <ArticleCompactCardBase
                testID={`explore-search-result-${item._id}`}
                imageUrl={item.image_url}
                titleEnglish={item.title_en}
                pubDate={item.pubDate}
                countryCode={alpha2ToAlpha3(item.country_code)}
                publicationName={item.publication_name}
                onPress={() => onPressHit(item)}
            />
        ),
        [onPressHit],
    );

    const keyExtractor = useCallback((item: NewsSearchHit) => item._id, []);

    if (status === 'idle') {
        return (
            <VStack
                testID="explore-search-min-length"
                className="items-center justify-center py-16 p-6"
                space="sm"
            >
                <Text size="sm" className="text-gray-400 text-center">
                    {t('explore.searchMinLength')}
                </Text>
            </VStack>
        );
    }

    if (status === 'loading') {
        return (
            <Box testID="explore-search-loading" className="items-center justify-center py-20">
                <Spinner size="large" />
            </Box>
        );
    }

    if (status === 'error') {
        const isNotSubscribed = errorKind === 'not-subscribed';
        return (
            <VStack
                testID="explore-search-error"
                className="items-center justify-center py-16 p-6"
                space="md"
            >
                <MaterialIcons name="error-outline" size={40} color="#666666" />
                <Text size="md" className="text-gray-400 text-center">
                    {isNotSubscribed ? t('explore.searchNotSubscribed') : t('explore.searchError')}
                </Text>
                <Button
                    testID="explore-search-error-action"
                    variant="outline"
                    size="sm"
                    onPress={isNotSubscribed ? handleSeePlans : onRetry}
                >
                    <ButtonText>{isNotSubscribed ? t('freeTier.seePlans') : t('common.retry')}</ButtonText>
                </Button>
            </VStack>
        );
    }

    // status === 'success'
    if (hits.length === 0) {
        return (
            <VStack testID="explore-search-empty" className="items-center justify-center py-16 p-6" space="md">
                <MaterialIcons name="search-off" size={40} color="#666666" />
                <Text size="md" className="text-gray-400 text-center">
                    {t('explore.searchEmpty')}
                </Text>
            </VStack>
        );
    }

    return (
        <FlatList
            testID="explore-search-results"
            data={hits}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            contentContainerStyle={{ padding: 16 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
        />
    );
};

export default ExploreSearchResults;
