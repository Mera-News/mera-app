import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
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
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    observeActive,
    untrackStory,
} from '@/lib/database/services/tracked-story-service';
import type TrackedStoryModel from '@/lib/database/models/TrackedStory';
import { hapticLight } from '@/lib/haptics';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface TrackedStoriesScreenProps {
    /** Embedded inside the For-You "Stories" sub-tab — hides the back button and
     *  tightens the header (the host owns the top chrome). Route usage omits it. */
    embedded?: boolean;
    /** Back handler for the non-embedded (route/deep-link) variant. */
    onBack?: () => void;
}

/**
 * The "Followed stories" list — every active tracked story, live via
 * `observeActive` (unseen-first, newest-next). Each row shows the LLM headline
 * (falling back to the tracked title), the latest development snippet, an unseen
 * badge, a relative timestamp, and — for auto-ended stories — an "Ended" pill.
 * Tapping opens the story timeline; long-press or the trash icon confirms
 * untracking. Rendered both embedded (For-You sub-tab) and as a standalone route.
 */
const TrackedStoriesScreen: React.FC<TrackedStoriesScreenProps> = ({ embedded = false, onBack }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [stories, setStories] = useState<TrackedStoryModel[]>([]);
    const [confirmTarget, setConfirmTarget] = useState<TrackedStoryModel | null>(null);

    useEffect(() => {
        const sub = observeActive().subscribe({
            next: (rows) => setStories(rows),
            error: () => setStories([]),
        });
        return () => sub.unsubscribe();
    }, []);

    const openTimeline = useCallback((story: TrackedStoryModel) => {
        router.push({
            pathname: '/logged-in/story-timeline',
            params: { trackedStoryId: story.id },
        });
    }, []);

    const handleConfirmUntrack = useCallback(async () => {
        if (!confirmTarget) return;
        const id = confirmTarget.id;
        setConfirmTarget(null);
        await untrackStory(id);
        // The observeActive subscription drops the row automatically.
    }, [confirmTarget]);

    const renderItem: ListRenderItem<TrackedStoryModel> = useCallback(
        ({ item }) => {
            const headline = item.llmHeadline ?? item.fallbackTitle;
            const latest = item.latestTitle;
            const showLatest = !!latest && latest.trim().length > 0 && latest !== headline;
            const unseen = item.unseenCount ?? 0;
            const relative = formatTimeAgo(t, item.lastUpdateAt ?? item.createdAt);
            return (
                <Pressable
                    onPress={() => openTimeline(item)}
                    onLongPress={() => {
                        hapticLight();
                        setConfirmTarget(item);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={headline}
                    className="mx-4 mb-3 rounded-2xl border border-gray-800 bg-gray-900 px-4 py-3"
                >
                    <HStack className="items-start" space="sm">
                        <VStack className="flex-1 min-w-0" space="xs">
                            <HStack className="items-center flex-wrap" space="xs">
                                {unseen > 0 && (
                                    <Box className="rounded-full bg-primary-400 px-2 py-0.5">
                                        <Text size="2xs" className="text-black font-bold">
                                            {t('trackedStories.updatesBadge', { count: unseen })}
                                        </Text>
                                    </Box>
                                )}
                                {item.status === 'ended' && (
                                    <Box className="rounded-full bg-gray-700 px-2 py-0.5">
                                        <Text size="2xs" className="text-gray-300 font-semibold">
                                            {t('trackedStories.endedLabel')}
                                        </Text>
                                    </Box>
                                )}
                            </HStack>
                            <TranslatableDynamic
                                text={headline}
                                as="heading"
                                size="md"
                                numberOfLines={2}
                                className="text-white"
                            />
                            {showLatest && (
                                <TranslatableDynamic
                                    text={latest as string}
                                    size="xs"
                                    numberOfLines={1}
                                    className="text-typography-400"
                                />
                            )}
                            {!!relative && (
                                <Text size="2xs" className="text-typography-500 mt-0.5">
                                    {relative}
                                </Text>
                            )}
                        </VStack>
                        <Pressable
                            onPress={() => setConfirmTarget(item)}
                            hitSlop={10}
                            accessibilityRole="button"
                            accessibilityLabel={t('trackedStories.untrackAction')}
                            className="p-1"
                        >
                            <MaterialIcons name="delete-outline" size={20} color="#9CA3AF" />
                        </Pressable>
                    </HStack>
                </Pressable>
            );
        },
        [t, openTimeline],
    );

    const keyExtractor = useCallback((item: TrackedStoryModel) => item.id, []);

    const ListEmpty = (
        <Box className="flex-1 items-center justify-center px-8 py-20">
            <MaterialIcons name="auto-awesome" size={48} color="#6B7280" />
            <Text size="lg" className="text-white text-center font-semibold mt-4">
                {t('trackedStories.emptyTitle')}
            </Text>
            <Text size="sm" className="text-typography-400 text-center mt-2">
                {t('trackedStories.emptyBody')}
            </Text>
        </Box>
    );

    return (
        <Box className="flex-1 bg-black">
            {!embedded && (
                <Box style={{ position: 'absolute', left: 8, top: insets.top + 8, zIndex: 20 }}>
                    <Pressable
                        onPress={onBack}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                    >
                        <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                    </Pressable>
                </Box>
            )}

            <VStack className="px-5 pb-2" style={{ paddingTop: embedded ? 8 : insets.top + 16 }}>
                <Heading size="3xl" className={embedded ? 'text-white' : 'text-white ml-14'}>
                    {t('trackedStories.title')}
                </Heading>
            </VStack>

            <FlatList
                data={stories}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListEmptyComponent={ListEmpty}
                contentContainerStyle={{
                    paddingTop: 12,
                    paddingBottom: insets.bottom + 40,
                    flexGrow: 1,
                }}
                showsVerticalScrollIndicator={false}
            />

            <Modal isOpen={!!confirmTarget} onClose={() => setConfirmTarget(null)}>
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader>
                        <Heading size="md" className="text-white">
                            {t('trackedStories.untrackConfirmTitle')}
                        </Heading>
                    </ModalHeader>
                    <ModalBody>
                        <Text size="sm" className="text-typography-300">
                            {t('trackedStories.untrackConfirmBody')}
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
                        <Button action="negative" onPress={handleConfirmUntrack}>
                            <ButtonText>{t('trackedStories.untrackAction')}</ButtonText>
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </Box>
    );
};

export default TrackedStoriesScreen;
