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
import { notifyScrollTick } from '@/lib/visibility-tick';

interface ExploreSearchResultsProps {
    readonly status: NewsSearchStatus;
    readonly hits: NewsSearchHit[];
    readonly errorKind: NewsSearchErrorKind | null;
    readonly onPressHit: (hit: NewsSearchHit) => void;
    readonly onRetry: () => void;
    /** No device link: the idle and error states say so instead. */
    readonly offline?: boolean;
}

/**
 * The full-screen Search route's results (`components/custom/world/SearchScreen`).
 *
 * Rendered purely off `useNewsSearch`'s status:
 *   - 'idle'    → nothing typed yet, or below the server's 2-char floor:
 *                 what search covers (or, offline, that it needs a link).
 *   - 'loading' → debounce settled, fetch in flight.
 *   - 'error'   → 402 (`not-subscribed`) gets its own "needs a plan" message
 *                 + a paywall entry point; anything else is a generic retry.
 *   - 'success' with zero hits → a gentle empty state — `searchNews` covers the
 *     last 48h, not the full archive, so "no articles found" would overstate
 *     what was actually searched.
 *   - 'success' with hits → a count line, then one compact row each. The
 *     count is the rows shown: the server caps a search at
 *     SEARCH_NEWS_MAX_RESULTS (25), so "25 stories" can understate.
 */
const ExploreSearchResults: React.FC<ExploreSearchResultsProps> = ({
    status,
    hits,
    errorKind,
    onPressHit,
    onRetry,
    offline = false,
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
            <VStack testID="explore-search-idle" className="items-center justify-center py-16 p-6" space="md">
                <MaterialIcons
                    name={offline ? 'cloud-off' : 'search'}
                    size={40}
                    color="#666666"
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                />
                <Text size="md" className="text-gray-400 text-center">
                    {offline ? t('world.offline') : t('world.search.empty')}
                </Text>
                {offline ? null : (
                    <Text size="sm" className="text-gray-500 text-center" testID="explore-search-privacy">
                        {t('world.search.privacy')}
                    </Text>
                )}
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
                <MaterialIcons name="error-outline" size={40} color="#666666" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
                <Text size="md" className="text-gray-400 text-center">
                    {isNotSubscribed
                        ? t('explore.searchNotSubscribed')
                        : offline
                          ? t('world.offline')
                          : t('world.search.errorRetry')}
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
            // One plain line and what to try; the words stay in the field.
            <VStack testID="explore-search-empty" className="items-center justify-center py-16 p-6" space="xs">
                <Text size="md" bold className="text-white text-center">
                    {t('world.search.noMatch')}
                </Text>
                <Text size="sm" className="text-gray-400 text-center">
                    {t('world.search.noMatchTry')}
                </Text>
            </VStack>
        );
    }

    return (
        <FlatList
            // Rows below the first screen ask for their translation only
            // when a scroll tick finds them on screen (lib/visibility-tick).
            onScroll={notifyScrollTick}
            scrollEventThrottle={16}
            onContentSizeChange={notifyScrollTick}
            testID="explore-search-results"
            data={hits}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            ListHeaderComponent={
                <Text size="sm" className="text-gray-400 font-semibold mb-2" testID="explore-search-count">
                    {t('world.search.count', { count: hits.length })}
                </Text>
            }
            contentContainerStyle={{ padding: 16 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
        />
    );
};

export default ExploreSearchResults;
