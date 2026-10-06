import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { ArticleStandaloneCard } from '@/components/custom/cards/ArticleStandaloneCard';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import {
    Modal,
    ModalBackdrop,
    ModalBody,
    ModalContent,
    ModalFooter,
    ModalHeader,
} from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import {
    deleteSavedSuggestion,
    loadSavedItems,
    type SavedItem,
} from '@/lib/database/services/saved-article-suggestion-service';
import logger from '@/lib/logger';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import SavedExportRow, { SAVED_EXPORT_ROW_HEIGHT } from './SavedExportRow';
import SavedExportModal from './SavedExportModal';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { savedItemId } from './saved-item-id';
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListRenderItem, StyleSheet, View } from 'react-native';
import Animated, { type SharedValue, useAnimatedScrollHandler } from 'react-native-reanimated';
import { notifyScrollTick } from '@/lib/visibility-tick';

interface SavedSuggestionsScreenProps {
    /** The host's collapsing-header scroll handler. The list MUST be an
     *  `Animated.FlatList` for this to do anything: a worklet attached to a
     *  plain RN `FlatList` never reaches the UI thread. */
    scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** Measured height of the host's collapsing header. The export row sits
     *  directly under it and the list pads by both, so the rows scroll UNDER
     *  the header and the row. */
    headerHeight?: number;
    /** The host header's 0..1 collapse value; the export row rides with it. */
    hidden?: SharedValue<number>;
    /** List-end padding (the host's clearance for the tab bar and the Mera
     *  button). Defaults to the tab-bar clearance plus a gap. */
    listEndPadding?: number;
    /** Drawn after the last row (the host's "How this page works" row). */
    footer?: React.ReactElement | null;
    /** False while Saved is a warmed or cached neighbour in a swipe window:
     *  no scroll ticks until it is the active panel. Default true. */
    active?: boolean;
}

// ── Delete-button geometry ────────────────────────────────────────────────
// The button floats over the card's top-right corner, so the card's own
// right-aligned meta row (time · language · country flag) runs UNDERNEATH it.
// On a card WITH a hero image the 192px image pushes that row far clear; on an
// imageless card the row sits directly under the button and the country flag
// was almost entirely covered — only a sliver of it showed past the trash
// circle. Moving the button was not enough (a right-aligned row follows it
// wherever it goes); the row has to RESERVE the space instead.
//
// Exported to the card via `metaRowRightReserve`, which is quoted from the
// card's OUTER right edge — the card subtracts its own content padding, and
// applies it only when it has no hero image.
const DELETE_BUTTON_SIZE = 36; // p-2 (8px) × 2 + a 20px icon
const DELETE_BUTTON_GAP = 8; // breathing room between the flag and the button
/** Where the delete button sits, from the right edge.
 *
 *  It used to be pushed inward by EDGE_SWIPE_SAFE_RIGHT_INSET to clear the
 *  Dashboard's right-edge swipe strip, which was drawn OVER this row and ate
 *  every tap inside its band — at the old `right: 5%` the button's 34px
 *  footprint spanned x 348..382 on a 402pt screen and was unpressable by
 *  coordinate AND by accessibility ref. That strip is gone, so the clearance is
 *  gone with it rather than surviving as a magic inset nobody can explain: an
 *  inset that once meant "keep away from here" is worse than none once the
 *  hazard is removed, because the next person preserves it for a reason that no
 *  longer exists. */
const DELETE_BUTTON_EDGE = 8;
const DELETE_BUTTON_RESERVE =
    DELETE_BUTTON_EDGE + DELETE_BUTTON_SIZE + DELETE_BUTTON_GAP;

const SavedSuggestionsScreen: React.FC<SavedSuggestionsScreenProps> = ({
    scrollHandler,
    headerHeight = 0,
    hidden,
    listEndPadding,
    footer,
    active = true,
}) => {
    const { t } = useTranslation();
    const toast = useToast();
    // Inside a tab on iOS the inset already includes the tab bar; measured on
    // device, adding TAB_BAR_HEIGHT left ~2x the bar of dead space at the end.
    const tabClearance = useTabBarClearance();
    const [saved, setSaved] = useState<SavedItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    // The row pending deletion — non-null opens the confirm dialog.
    const [confirmTarget, setConfirmTarget] = useState<SavedItem | null>(null);
    const [exportOpen, setExportOpen] = useState(false);

    // Reload on focus so a save made elsewhere (detail screen) shows up when
    // the user navigates back here.
    useFocusEffect(
        useCallback(() => {
            let cancelled = false;
            loadSavedItems()
                .then((rows) => {
                    if (!cancelled) setSaved(rows);
                })
                .catch((err) => {
                    logger.captureException(err, {
                        tags: { screen: 'SavedSuggestionsScreen', method: 'load' },
                    });
                })
                .finally(() => {
                    if (!cancelled) setIsLoading(false);
                });
            return () => {
                cancelled = true;
            };
        }, []),
    );

    const handleSuggestionPress = useCallback((suggestionId: string) => {
        router.push({
            pathname: '/logged-in/suggestion-detail',
            params: { articleSuggestionId: suggestionId },
        });
    }, []);

    const handleArticlePress = useCallback((articleId: string) => {
        router.push({
            pathname: '/logged-in/article-detail',
            params: { articleId },
        });
    }, []);

    const handleConfirmDelete = useCallback(async () => {
        if (!confirmTarget) return;
        const target = confirmTarget;
        const targetId = savedItemId(target);
        setConfirmTarget(null);
        try {
            await deleteSavedSuggestion(targetId);
            setSaved((prev) => prev.filter((s) => savedItemId(s) !== targetId));
            toast.show({
                placement: 'top',
                duration: 3000,
                render: ({ id }: { id: string }) => (
                    <Toast nativeID={id} action="success" variant="solid">
                        <ToastTitle>{t('savedSuggestions.removedToastTitle')}</ToastTitle>
                        <ToastDescription>
                            {t('savedSuggestions.removedToastMessage')}
                        </ToastDescription>
                    </Toast>
                ),
            });
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'SavedSuggestionsScreen', method: 'delete' },
                extra: { id: targetId },
            });
        }
    }, [confirmTarget, toast, t]);

    // Raised by the wizard when the export could not be handed off at all,
    // which after the text fallback means the OS refused every route. The
    // screen owns it because the screen owns `toast`.
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

    const renderItem: ListRenderItem<SavedItem> = useCallback(
        ({ item }) => (
            // `mx-4`: the SAME inset as the info note above the list, so the
            // cards no longer run edge to edge under an inset note.
            <Box className="relative mx-4" testID={`saved-item-${savedItemId(item)}`}>
                {/* Both rows pass `flat`: it is the surface the Feed and
                    Dashboard article cards render through (rounded-2xl, hairline
                    border, drop shadow, full-bleed hero), and Saved is the same
                    kind of list. Without it these were the app's ONLY cards still
                    on ArticleCardBase's older `Card`-wrapped chrome — rounded-md,
                    no shadow, and a hero inset by the Card's own p-4.

                    It also makes DELETE_BUTTON_RESERVE correct. The reserve is
                    quoted from the card's outer right edge and ArticleCardBase
                    subtracts only the content VStack's px-4; the non-flat branch
                    added a further 16px of Card padding, so this screen — the
                    reserve's only caller — was under-reserving by 16px. */}
                {item.origin === 'article' ? (
                    <ArticleStandaloneCard
                        article={item.article}
                        onPress={() => handleArticlePress(item.article._id)}
                        subjectExtras={{ surface: 'saved' }}
                        metaRowRightReserve={DELETE_BUTTON_RESERVE}
                        flat
                    />
                ) : (
                    <ArticleSuggestionCard
                        suggestion={item.suggestion}
                        onPress={(s) => handleSuggestionPress(s._id)}
                        metaRowRightReserve={DELETE_BUTTON_RESERVE}
                        flat
                    />
                )}
                {/* Delete affordance, at the right edge. It used to be inset to
                    clear the Dashboard's right-edge swipe strip, which was drawn
                    OVER this row and ate every tap inside its band — that is why
                    the control appeared completely dead. `right` is a fixed
                    inset, not a percentage, so the clearance can't drift with the
                    card's width; `hitSlop` grows the target everywhere EXCEPT
                    rightwards, so it never reaches back into the strip. */}
                {/* The circle holds the glyph and a CHILDLESS labelled button
                    filling it: a glyph inside a button surfaces on iOS as its
                    own StaticText (captured, one per row). */}
                <View
                    className="bg-gray-900 rounded-full p-2 shadow-hard-2"
                    style={{
                        position: 'absolute',
                        top: 8,
                        right: DELETE_BUTTON_EDGE,
                        zIndex: 10,
                    }}
                >
                    <MaterialIcons
                        name="delete"
                        size={20}
                        color="#ffffff"
                        accessible={false}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    />
                    <Pressable
                        testID="saved-delete"
                        onPress={() => setConfirmTarget(item)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 4 }}
                        accessibilityRole="button"
                        accessibilityLabel={t('savedSuggestions.deleteConfirmCta')}
                        style={StyleSheet.absoluteFill}
                    />
                </View>
            </Box>
        ),
        [handleArticlePress, handleSuggestionPress, t],
    );

    const keyExtractor = useCallback(
        (item: SavedItem, index: number) => savedItemId(item) || `saved-${index}`,
        [],
    );

    // No rows, nothing to export: the row is absent on the empty state.
    const showExportRow = saved.length > 0;

    // After a delete leaves the list SHORTER than the screen, iOS keeps the old
    // scroll offset: the rows sat part-way up under the Dashboard header (a
    // delete button at y=198pt under a 211pt header, captured), and with
    // nothing left to scroll, swipes and scroll-to-top could not bring them
    // back. When the content fits, settle it back to the top, which also
    // reveals the collapsing header.
    const listRef = useRef<any>(null);
    const viewportH = useRef(0);
    const settleIfShort = useCallback((_w: number, contentH: number) => {
        // New content can land rows on screen with no scroll: re-measure them.
        // Only the active panel feeds the translation scheduler.
        if (active) notifyScrollTick();
        if (viewportH.current > 0 && contentH <= viewportH.current) {
            listRef.current?.scrollToOffset?.({ offset: 0, animated: true });
        }
    }, [active]);

    const ListEmpty = isLoading ? (
        <Box className="items-center justify-center py-20">
            <Spinner size="large" />
        </Box>
    ) : (
        <ForYouEmptyState
            icon="bookmark-border"
            title={t('savedSuggestions.emptyTitle')}
            body={t('library.saved.emptyBody')}
            testID="saved-empty"
        />
    );

    return (
        <Box className="flex-1">
            <Animated.FlatList
                ref={listRef}
                testID="saved-suggestions-list"
                data={saved}
                onLayout={(e) => {
                    viewportH.current = e.nativeEvent.layout.height;
                }}
                onContentSizeChange={settleIfShort}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListFooterComponent={footer ?? null}
                ListEmptyComponent={ListEmpty}
                contentContainerStyle={{
                    // 12pt below the export row (or the header, with no row).
                    paddingTop: headerHeight + (showExportRow ? SAVED_EXPORT_ROW_HEIGHT : 0) + 12,
                    // Clear of the tab bar and the Mera button, which sits
                    // bottom right: without it the last card's top-right
                    // delete button lands under the button.
                    paddingBottom: listEndPadding ?? tabClearance + 24,
                }}
                showsVerticalScrollIndicator={false}
                // The host's collapsible-header handler ticks; with none, tick
                // directly. At rest, a content change re-measures (see
                // settleIfShort).
                onScroll={scrollHandler ?? notifyScrollTick}
                scrollEventThrottle={16}
            />

            {/* Pinned under the page header; the list scrolls beneath it. */}
            {showExportRow && (
                <SavedExportRow
                    count={saved.length}
                    headerHeight={headerHeight}
                    hidden={hidden}
                    onExport={() => setExportOpen(true)}
                />
            )}

            <SavedExportModal
                isOpen={exportOpen}
                onClose={() => setExportOpen(false)}
                items={saved}
                onFailed={handleExportFailed}
            />

            {/* Delete confirmation (Gluestack Modal) */}
            <Modal isOpen={!!confirmTarget} onClose={() => setConfirmTarget(null)}>
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader>
                        <Heading size="lg" className="text-white">
                            {t('savedSuggestions.deleteConfirmTitle')}
                        </Heading>
                    </ModalHeader>
                    <ModalBody>
                        <Text size="sm" className="text-typography-300">
                            {t('savedSuggestions.deleteConfirmMessage')}
                        </Text>
                    </ModalBody>
                    <ModalFooter>
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setConfirmTarget(null)}
                            className="mr-3"
                        >
                            <ButtonText>{t('common.cancel')}</ButtonText>
                        </Button>
                        <Button action="negative" onPress={handleConfirmDelete}>
                            <ButtonText>{t('savedSuggestions.deleteConfirmCta')}</ButtonText>
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </Box>
    );
};

export default SavedSuggestionsScreen;
