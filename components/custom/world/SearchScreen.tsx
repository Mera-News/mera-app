import ExploreSearchBar from '@/components/custom/explore/ExploreSearchBar';
import ExploreSearchResults from '@/components/custom/explore/ExploreSearchResults';
import { tabRoute } from '@/components/custom/nav/page-registry';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type { NewsSearchHit } from '@/lib/generated/graphql-types';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import { useNewsSearch } from '@/lib/news-search/use-news-search';
import { useIsConnected } from '@/lib/stores/network-store';
import { router } from 'expo-router';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const CANCEL_STYLE = { minHeight: 44, justifyContent: 'center', paddingLeft: 12 } as const;

/**
 * Full-screen search, opened from the World header's search icon. A root
 * Stack push, so the World page underneath stays mounted and Cancel (or
 * Android Back, the Stack's own pop) lands on it scrolled where it was.
 *
 * Nothing typed is stored: the query lives in `useNewsSearch`'s state and
 * dies with this screen. No Mera button here (it hides on the `search`
 * surface). Results cover every source and country, not the page the reader
 * came from.
 */
const SearchScreen: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const search = useNewsSearch();
    const openArticle = useOpenArticle();
    const isConnected = useIsConnected();

    const handleCancel = useCallback(() => {
        // A cold deep link has nothing under it: land on the Feed tab.
        if (router.canGoBack()) router.back();
        else router.replace(tabRoute('feed'));
    }, []);
    const handlePressHit = useCallback(
        (hit: NewsSearchHit) => openArticle({ articleId: hit._id }),
        [openArticle],
    );

    return (
        <Box className="flex-1 bg-black" testID="search-screen">
            <HStack className="items-center px-4 pb-2" style={{ paddingTop: insets.top + 8 }}>
                <ExploreSearchBar
                    query={search.query}
                    onChangeQuery={search.setQuery}
                    placeholder={t('world.search.placeholder')}
                />
                <Pressable
                    testID="search-cancel"
                    onPress={handleCancel}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                    style={CANCEL_STYLE}
                >
                    <Text size="md" className="text-primary-400 font-semibold">
                        {t('common.cancel')}
                    </Text>
                </Pressable>
            </HStack>
            <Box className="flex-1">
                <ExploreSearchResults
                    status={search.status}
                    hits={search.hits}
                    errorKind={search.errorKind}
                    onPressHit={handlePressHit}
                    onRetry={search.retry}
                    offline={!isConnected}
                />
            </Box>
        </Box>
    );
};

export default SearchScreen;
