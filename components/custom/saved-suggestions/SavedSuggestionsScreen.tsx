// The Library's Saved page (FinalLibrary #1-3): compact rows that scale, under
// the pinned "N saved ?" row with the glass Export button.
//
// No delete circle on the rows: removing is the compact row's ••• > Remove from
// saved, which publishes the change (lib/saved-state), and `SavedRow` drops the
// row at once. The list then settles to the top if what is left fits: on iOS a
// list that shrinks below its viewport keeps its old offset otherwise, with
// nothing left to scroll back by.

import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import { ArticleSuggestionCompactCard } from '@/components/custom/cards/ArticleSuggestionCompactCard';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import PageTitleRow from '@/components/custom/nav/PageTitleRow';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { loadSavedItems, type SavedItem } from '@/lib/database/services/saved-article-suggestion-service';
import logger from '@/lib/logger';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { getSavedOverride, useSavedCount, useSavedOverride } from '@/lib/saved-state';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ListRenderItem } from 'react-native';
import Animated, { type SharedValue, useAnimatedScrollHandler } from 'react-native-reanimated';
import SavedExportModal from './SavedExportModal';
import SavedExportRow, { SAVED_EXPORT_ROW_HEIGHT } from './SavedExportRow';
import { savedItemId } from './saved-item-id';
import { PAGE_CONTENT_GAP } from '@/components/custom/nav/page-registry';

interface SavedSuggestionsScreenProps {
    /** The tab's collapsing-header scroll handler (an Animated.FlatList's). */
    scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** The tab header's height; the pinned row sits under it. */
    headerHeight?: number;
    /** The header's 0..1 collapse value; the pinned row rides with it. */
    hidden?: SharedValue<number>;
    /** List-end padding (the tab bar and the Mera button). */
    listEndPadding?: number;
    /** Opens Saved's explainer (the ? beside the count). */
    onExplain?: () => void;
    /** False while Saved is a warmed neighbour: no scroll ticks. */
    active?: boolean;
}

/** One saved row; null once removed from saved in this session. */
const SavedRow: React.FC<{ readonly item: SavedItem }> = ({ item }) => {
    const saved = useSavedOverride(savedItemId(item));
    if (saved === false) return null;
    return item.origin === 'article' ? (
        <ArticleStandaloneCompactCard
            article={item.article}
            onPress={() => router.push({ pathname: '/logged-in/article-detail', params: { articleId: item.article._id } })}
            subjectExtras={{ surface: 'saved' }}
            testID={`saved-item-${savedItemId(item)}`}
        />
    ) : (
        <ArticleSuggestionCompactCard
            suggestion={item.suggestion}
            onPress={(s) =>
                router.push({ pathname: '/logged-in/suggestion-detail', params: { articleSuggestionId: s._id } })
            }
            surface="saved"
        />
    );
};

const SavedSuggestionsScreen: React.FC<SavedSuggestionsScreenProps> = ({
    scrollHandler,
    headerHeight = 0,
    hidden,
    listEndPadding,
    onExplain,
    active = true,
}) => {
    const { t } = useTranslation();
    const toast = useToast();
    const tabClearance = useTabBarClearance();
    const [saved, setSaved] = useState<SavedItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [exportOpen, setExportOpen] = useState(false);

    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            loadSavedItems()
                .then((rows) => {
                    if (!cancelled) setSaved(rows);
                })
                .catch((err) => {
                    logger.captureException(err, { tags: { screen: 'SavedSuggestionsScreen', method: 'load' } });
                })
                .finally(() => {
                    if (!cancelled) setIsLoading(false);
                });
            return () => {
                cancelled = true;
            };
        }, []),
    );

    const handleExportFailed = useCallback(() => {
        toast.show({
            placement: 'top',
            duration: 4000,
            render: ({ id }: { id: string }) => (
                <Toast nativeID={id} action="error" variant="solid">
                    <ToastTitle>{t('savedExport.failedTitle')}</ToastTitle>
                    <ToastDescription>{t('savedExport.failedMessage')}</ToastDescription>
                </Toast>
            ),
        });
    }, [toast, t]);

    const savedIds = useMemo(() => saved.map(savedItemId), [saved]);
    const savedCount = useSavedCount(savedIds);
    // What Export offers: never a row removed this visit.
    const exportItems = useMemo(
        () => saved.filter((it) => getSavedOverride(savedItemId(it)) !== false),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [saved, savedCount],
    );

    const renderItem: ListRenderItem<SavedItem> = useCallback(({ item }) => <SavedRow item={item} />, []);
    const keyExtractor = useCallback((item: SavedItem, index: number) => savedItemId(item) || `saved-${index}`, []);

    const listRef = useRef<any>(null);
    const viewportH = useRef(0);
    const settleIfShort = useCallback(
        (_w: number, contentH: number) => {
            if (active) notifyScrollTick();
            if (viewportH.current > 0 && contentH <= viewportH.current) {
                listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
            }
        },
        [active],
    );

    // The pinned row only while something is saved; the empty page carries a
    // plain "Saved ?" title row in the list instead (FinalLibrary #3).
    const showRow = !isLoading && savedCount > 0;

    // Everything removed this visit: the empty state, without a reload.
    const ListEmpty = isLoading ? (
        <Box className="items-center justify-center py-20">
            <Spinner size="large" />
        </Box>
    ) : (
        <ForYouEmptyState
            icon="bookmark-border"
            title={t('savedSuggestions.emptyTitle')}
            body={t('library.saved.emptyBody')}
            action={{ label: t('library.saved.learn'), onPress: () => openTutorial('library', 'saved'), testID: 'saved-learn' }}
            testID="saved-empty"
        />
    );

    return (
        <Box className="flex-1">
            <Animated.FlatList
                ref={listRef}
                testID="saved-suggestions-list"
                data={savedCount === 0 ? [] : saved}
                onLayout={(e) => {
                    viewportH.current = e.nativeEvent.layout.height;
                }}
                onContentSizeChange={settleIfShort}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListHeaderComponent={
                    showRow || isLoading ? null : (
                        <PageTitleRow title={t('nav.page.saved')} onExplain={onExplain} testID="saved-title-row" />
                    )
                }
                ListEmptyComponent={ListEmpty}
                contentContainerStyle={{
                    // 12pt below the pinned row.
                    paddingTop: headerHeight + (showRow ? SAVED_EXPORT_ROW_HEIGHT : 0) + PAGE_CONTENT_GAP,
                    paddingHorizontal: 12,
                    paddingBottom: listEndPadding ?? tabClearance + 24,
                    flexGrow: 1,
                }}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler ?? notifyScrollTick}
                scrollEventThrottle={16}
            />

            {/* Pinned under the page header; the list scrolls beneath it. */}
            {showRow ? (
                <SavedExportRow
                    count={savedCount}
                    headerHeight={headerHeight}
                    hidden={hidden}
                    onExplain={onExplain}
                    onExport={() => setExportOpen(true)}
                />
            ) : null}

            <SavedExportModal
                isOpen={exportOpen}
                onClose={() => setExportOpen(false)}
                items={exportItems}
                onFailed={handleExportFailed}
            />
        </Box>
    );
};

export default SavedSuggestionsScreen;
