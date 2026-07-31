import { ArticleSuggestionCard } from '@/components/custom/cards/ArticleSuggestionCard';
import { ArticleStandaloneCard } from '@/components/custom/cards/ArticleStandaloneCard';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
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
import { VStack } from '@/components/ui/vstack';
import {
    deleteSavedSuggestion,
    loadSavedItems,
    type SavedItem,
} from '@/lib/database/services/saved-article-suggestion-service';
import logger from '@/lib/logger';
import { EDGE_SWIPE_SAFE_RIGHT_INSET } from '@/lib/navigation/edge-swipe';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface SavedSuggestionsScreenProps {
    onBack: () => void;
    /** When embedded inside another screen (e.g. the For-You "Saved" sub-tab),
     *  the floating back button is hidden and the header padding is tightened —
     *  the host already owns the top chrome. Route usage leaves this unset. */
    embedded?: boolean;
}

/** The WMDB row id backing a saved item (suggestion `_id` or the article's savedId). */
const itemId = (item: SavedItem): string =>
    item.origin === 'suggestion' ? item.suggestion._id : item.savedId;

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
const DELETE_BUTTON_RESERVE =
    EDGE_SWIPE_SAFE_RIGHT_INSET + DELETE_BUTTON_SIZE + DELETE_BUTTON_GAP;

const SavedSuggestionsScreen: React.FC<SavedSuggestionsScreenProps> = ({ onBack, embedded = false }) => {
    const { t } = useTranslation();
    const toast = useToast();
    const insets = useSafeAreaInsets();
    const [saved, setSaved] = useState<SavedItem[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    // The row pending deletion — non-null opens the confirm dialog.
    const [confirmTarget, setConfirmTarget] = useState<SavedItem | null>(null);

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
        const targetId = itemId(target);
        setConfirmTarget(null);
        try {
            await deleteSavedSuggestion(targetId);
            setSaved((prev) => prev.filter((s) => itemId(s) !== targetId));
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

    const renderItem: ListRenderItem<SavedItem> = useCallback(
        ({ item }) => (
            <Box className="relative">
                {item.origin === 'article' ? (
                    <ArticleStandaloneCard
                        article={item.article}
                        onPress={() => handleArticlePress(item.article._id)}
                        subjectExtras={{ surface: 'saved' }}
                        metaRowRightReserve={DELETE_BUTTON_RESERVE}
                    />
                ) : (
                    <ArticleSuggestionCard
                        suggestion={item.suggestion}
                        onPress={(s) => handleSuggestionPress(s._id)}
                        metaRowRightReserve={DELETE_BUTTON_RESERVE}
                    />
                )}
                {/* Delete affordance. Kept clear of the Dashboard's right-edge
                    swipe strip (EDGE_SWIPE_SAFE_RIGHT_INSET): when this screen is
                    embedded as the Saved sub-tab, that strip is drawn OVER this
                    row and silently eats every tap inside its band — at the old
                    `right: 5%` the button's centre sat inside it, which is why
                    the control appeared completely dead. `right` is a fixed
                    inset, not a percentage, so the clearance can't drift with the
                    card's width; `hitSlop` grows the target everywhere EXCEPT
                    rightwards, so it never reaches back into the strip. */}
                <Pressable
                    testID="saved-delete"
                    onPress={() => setConfirmTarget(item)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 4 }}
                    accessibilityRole="button"
                    accessibilityLabel={t('savedSuggestions.deleteConfirmCta')}
                    className="bg-gray-900 rounded-full p-2 shadow-hard-2"
                    style={{
                        position: 'absolute',
                        top: 8,
                        right: EDGE_SWIPE_SAFE_RIGHT_INSET,
                        zIndex: 10,
                    }}
                >
                    <MaterialIcons name="delete" size={20} color="#ffffff" />
                </Pressable>
            </Box>
        ),
        [handleArticlePress, handleSuggestionPress, t],
    );

    const keyExtractor = useCallback(
        (item: SavedItem, index: number) => itemId(item) || `saved-${index}`,
        [],
    );

    const ListHeader = (
        <Box
            className="mx-4 mb-4 px-3 py-2 border border-primary-500 rounded-lg bg-gray-900"
            accessibilityRole="summary"
        >
            <HStack className="items-start" space="sm">
                <MaterialIcons
                    name="info-outline"
                    size={16}
                    color="#9ca3af"
                    style={{ marginTop: 2 }}
                />
                <Text size="xs" className="text-gray-400 flex-1">
                    {t('savedSuggestions.note')}
                </Text>
            </HStack>
        </Box>
    );

    const ListEmpty = isLoading ? (
        <Box className="items-center justify-center py-20">
            <Spinner size="large" />
        </Box>
    ) : (
        <Box className="items-center justify-center py-20 px-6">
            <MaterialIcons name="bookmark-border" size={48} color="#6B7280" />
            <Text size="md" className="text-typography-400 text-center mt-4">
                {t('savedSuggestions.empty')}
            </Text>
        </Box>
    );

    return (
        <Box className="flex-1">
            {/* Floating Back Button — hidden when embedded (host owns navigation). */}
            {!embedded && (
                <Box style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}>
                    <Pressable
                        onPress={onBack}
                        className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                    >
                        <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                    </Pressable>
                </Box>
            )}

            <VStack
                className="px-5 pb-2"
                style={{ paddingTop: embedded ? 8 : insets.top + 16 }}
            >
                <Heading size="3xl" className={embedded ? 'text-white' : 'text-white ml-14'}>
                    {t('savedSuggestions.title')}
                </Heading>
            </VStack>

            <FlatList
                data={saved}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                // The banner explains how saving works on THIS device; over an
                // empty list it explained a list that isn't there, stacked above
                // the "you haven't saved anything" state. Only shown with rows.
                ListHeaderComponent={saved.length > 0 ? ListHeader : null}
                ListEmptyComponent={ListEmpty}
                contentContainerStyle={{
                    paddingTop: 12,
                    // Embedded = rendered inside the Dashboard's "Saved" sub-tab,
                    // which sits INSIDE the floating tab navigator — needs the
                    // same tab-bar clearance as FeedScreen/DashboardSectionsFeed
                    // (safe-area bottom + tab-bar height + a fixed breathing-room
                    // tail). The standalone route (app/logged-in/saved-suggestions)
                    // is a Stack screen pushed OUTSIDE the tab navigator, so no
                    // tab bar renders behind it — just the safe-area clearance.
                    paddingBottom: embedded
                        ? insets.bottom + TAB_BAR_HEIGHT + 24
                        : insets.bottom + 40,
                }}
                showsVerticalScrollIndicator={false}
            />

            {/* Delete confirmation (Gluestack Modal) */}
            <Modal isOpen={!!confirmTarget} onClose={() => setConfirmTarget(null)}>
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader>
                        <Heading size="md" className="text-white">
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
