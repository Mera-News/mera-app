import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { observeActive } from '@/lib/database/services/tracked-story-service';
import type TrackedStoryModel from '@/lib/database/models/TrackedStory';
import { hapticLight } from '@/lib/haptics';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';

/**
 * Horizontal "Following" rail for the For-You feed pane. Self-contained: it
 * subscribes to `observeActive` and renders NOTHING unless at least one active
 * story has an unseen development — so it only appears when there's something new
 * to catch up on. Each chip shows the story headline + an unseen count; tapping
 * opens the story timeline.
 */
const TrackedStoriesRail: React.FC = () => {
    const { t } = useTranslation();
    const [stories, setStories] = useState<TrackedStoryModel[]>([]);

    useEffect(() => {
        const sub = observeActive().subscribe({
            next: (rows) => setStories(rows),
            error: () => setStories([]),
        });
        return () => sub.unsubscribe();
    }, []);

    const openTimeline = useCallback((story: TrackedStoryModel) => {
        hapticLight();
        router.push({
            pathname: '/logged-in/story-timeline',
            params: { trackedStoryId: story.id },
        });
    }, []);

    // Only stories with unseen developments earn a chip.
    const unseen = stories.filter((s) => (s.unseenCount ?? 0) > 0);
    if (unseen.length === 0) return null;

    return (
        <Box className="mb-3">
            <Text size="xs" className="text-typography-400 font-semibold px-5 mb-2 uppercase">
                {t('trackedStories.railTitle')}
            </Text>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 20 }}
            >
                <HStack space="sm">
                    {unseen.map((story) => (
                        <Pressable
                            key={story.id}
                            onPress={() => openTimeline(story)}
                            accessibilityRole="button"
                            accessibilityLabel={story.llmHeadline ?? story.fallbackTitle}
                            className="flex-row items-center rounded-full border border-primary-500 bg-gray-900 px-3 py-2"
                            style={{ maxWidth: 240 }}
                        >
                            <TranslatableDynamic
                                text={story.llmHeadline ?? story.fallbackTitle}
                                size="xs"
                                numberOfLines={1}
                                className="text-white font-semibold"
                            />
                            <Box className="ml-2 rounded-full bg-primary-400 px-1.5 py-0.5">
                                <Text size="2xs" className="text-black font-bold">
                                    {(story.unseenCount ?? 0) > 99 ? '99+' : story.unseenCount}
                                </Text>
                            </Box>
                        </Pressable>
                    ))}
                </HStack>
            </ScrollView>
        </Box>
    );
};

export default TrackedStoriesRail;
