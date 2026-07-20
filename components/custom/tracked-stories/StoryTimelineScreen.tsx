import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import {
    getTrackedStoryById,
    markSeen,
} from '@/lib/database/services/tracked-story-service';
import type { NewsArticle, TrackedStoryArticleSnapshot } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface StoryTimelineScreenProps {
    trackedStoryId: string;
    onBack: () => void;
}

/** Map a durable archive snapshot onto the NewsArticle shape the compact card
 *  expects. Snapshots are lean (no descriptions / language), so unmappable
 *  fields are left undefined — the card degrades gracefully. */
function snapshotToNewsArticle(snap: TrackedStoryArticleSnapshot): NewsArticle {
    return {
        _id: snap.articleId,
        title: snap.title_en,
        title_en_internal_only: snap.title_en,
        pubDate: snap.pubDate,
        image_url: snap.image_url ?? undefined,
        article_url: snap.article_url ?? undefined,
        original_language_code: undefined,
        publicationSource:
            snap.publication_name || snap.country_code
                ? ({
                      _id: snap.articleId,
                      publication_name: snap.publication_name,
                      country_code: snap.country_code,
                  } as NewsArticle['publicationSource'])
                : undefined,
    } as NewsArticle;
}

/**
 * A tracked story's timeline — the archived coverage gathered under its stable
 * cluster id, newest-first. Marks the story seen on mount (clears its unseen
 * badge). The header renders the LLM headline (falling back to the tracked
 * title). When no archive exists yet (never resolved a stable id, or the story
 * ended before coverage was captured), a quiet note stands in for the list.
 */
const StoryTimelineScreen: React.FC<StoryTimelineScreenProps> = ({ trackedStoryId, onBack }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [headline, setHeadline] = useState<string>('');
    const [stableClusterId, setStableClusterId] = useState<string | null>(null);
    const [snapshots, setSnapshots] = useState<TrackedStoryArticleSnapshot[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        // Clear the unseen badge as soon as the timeline opens.
        void markSeen(trackedStoryId);

        (async () => {
            try {
                const story = await getTrackedStoryById(trackedStoryId);
                if (cancelled) return;
                if (!story) {
                    setIsLoading(false);
                    return;
                }
                setHeadline(story.llmHeadline ?? story.fallbackTitle ?? '');

                const sid = story.stableClusterId;
                setStableClusterId(sid ?? null);
                if (sid) {
                    const archive = await ArticleService.getTrackedStory(sid);
                    if (cancelled) return;
                    setSnapshots(archive?.articles ?? []);
                }
            } catch (err) {
                logger.captureException(err, {
                    tags: { screen: 'StoryTimelineScreen', method: 'load' },
                    extra: { trackedStoryId },
                });
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [trackedStoryId]);

    const handleArticlePress = useCallback(
        (articleId: string, stableClusterId: string | null) => {
            router.push({
                pathname: '/logged-in/article-detail',
                params: stableClusterId
                    ? { articleId, stableClusterId }
                    : { articleId },
            });
        },
        [],
    );

    const renderItem: ListRenderItem<TrackedStoryArticleSnapshot> = useCallback(
        ({ item }) => {
            const article = snapshotToNewsArticle(item);
            return (
                <ArticleStandaloneCompactCard
                    article={article}
                    onPress={() => handleArticlePress(item.articleId, stableClusterId)}
                    showActions
                    subjectExtras={{
                        surface: 'tracked',
                        stableClusterId: stableClusterId ?? undefined,
                    }}
                />
            );
        },
        [handleArticlePress, stableClusterId],
    );

    const keyExtractor = useCallback(
        (item: TrackedStoryArticleSnapshot, index: number) => item.articleId || `snap-${index}`,
        [],
    );

    const ListEmpty = isLoading ? (
        <Box className="items-center justify-center py-20">
            <Spinner size="large" />
        </Box>
    ) : (
        <Box className="items-center justify-center py-20 px-8">
            <MaterialIcons name="hourglass-empty" size={40} color="#6B7280" />
            <Text size="sm" className="text-typography-400 text-center mt-4">
                {t('trackedStories.timelineQuietNote')}
            </Text>
        </Box>
    );

    return (
        <Box className="flex-1 bg-black">
            <VStack style={{ paddingTop: insets.top + 8 }}>
                <HStack className="items-center px-2 pb-2" space="sm">
                    <Pressable
                        onPress={onBack}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.cancel')}
                        hitSlop={8}
                        className="p-2"
                    >
                        <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                    </Pressable>
                    <Box className="flex-1 min-w-0 pr-3">
                        {!!headline && (
                            <TranslatableDynamic
                                text={headline}
                                as="heading"
                                size="lg"
                                numberOfLines={2}
                                className="text-white"
                            />
                        )}
                    </Box>
                </HStack>
            </VStack>

            <FlatList
                data={snapshots}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListEmptyComponent={ListEmpty}
                contentContainerStyle={{
                    paddingTop: 8,
                    paddingBottom: insets.bottom + 40,
                    flexGrow: 1,
                }}
                showsVerticalScrollIndicator={false}
            />
        </Box>
    );
};

export default StoryTimelineScreen;
