import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import type { TrackedStoryMemberSnapshot } from '@/lib/database/models/TrackedStory';
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

/** The card shape both the local member snapshots and the server archive
 *  snapshots are normalized into before rendering. `pubDateMs` drives the
 *  strict newest-first ordering that applies regardless of source. */
interface TimelineCard {
    articleId: string;
    title: string;
    pubDateMs: number;
    imageUrl?: string;
    publicationName?: string;
    countryCode?: string;
    articleUrl?: string;
}

function serverToCard(snap: TrackedStoryArticleSnapshot): TimelineCard {
    return {
        articleId: snap.articleId,
        title: snap.title_en ?? '',
        pubDateMs: snap.pubDate ? Date.parse(snap.pubDate) || 0 : 0,
        imageUrl: snap.image_url ?? undefined,
        publicationName: snap.publication_name ?? undefined,
        countryCode: snap.country_code ?? undefined,
        articleUrl: snap.article_url ?? undefined,
    };
}

function localToCard(snap: TrackedStoryMemberSnapshot): TimelineCard {
    return {
        articleId: snap.articleId,
        title: snap.title ?? '',
        pubDateMs: snap.pubDateMs ?? 0,
        imageUrl: snap.imageUrl,
        publicationName: snap.publicationName,
    };
}

/**
 * Merge the local member snapshots with the server archive snapshots, deduped
 * by articleId (local wins — it carries the freshest, reconcile-discovered
 * fields), then sorted strictly newest-first by pubDate. When a local snapshot's
 * title is empty we fall back to the server title (the server title-bug fix is
 * landing in parallel), and vice-versa — so the card never renders blank when
 * either source has a title.
 */
function mergeTimeline(
    local: TrackedStoryMemberSnapshot[],
    server: TrackedStoryArticleSnapshot[],
): TimelineCard[] {
    const byId = new Map<string, TimelineCard>();
    for (const s of server) {
        if (s.articleId) byId.set(s.articleId, serverToCard(s));
    }
    for (const l of local) {
        if (!l.articleId) continue;
        const base = byId.get(l.articleId);
        const localCard = localToCard(l);
        byId.set(l.articleId, {
            ...base,
            ...localCard,
            // Title / media fall back to the server snapshot when the local one
            // is missing them.
            title: localCard.title || base?.title || '',
            imageUrl: localCard.imageUrl ?? base?.imageUrl,
            publicationName: localCard.publicationName ?? base?.publicationName,
            countryCode: base?.countryCode,
            articleUrl: base?.articleUrl,
            pubDateMs: localCard.pubDateMs || base?.pubDateMs || 0,
        });
    }
    return [...byId.values()].sort((a, b) => b.pubDateMs - a.pubDateMs);
}

/** Map a merged timeline card onto the NewsArticle shape the compact card
 *  expects. Cards are lean (no descriptions / language), so unmappable fields
 *  are left undefined — the card degrades gracefully. */
function cardToNewsArticle(card: TimelineCard): NewsArticle {
    return {
        _id: card.articleId,
        title: card.title,
        title_en_internal_only: card.title,
        pubDate: card.pubDateMs ? new Date(card.pubDateMs).toISOString() : undefined,
        image_url: card.imageUrl,
        article_url: card.articleUrl,
        original_language_code: undefined,
        publicationSource:
            card.publicationName || card.countryCode
                ? ({
                      _id: card.articleId,
                      publication_name: card.publicationName,
                      country_code: card.countryCode,
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
    const [cards, setCards] = useState<TimelineCard[]>([]);
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

                const localSnapshots = story.memberSnapshots ?? [];
                const sid = story.stableClusterId;
                setStableClusterId(sid ?? null);

                let serverSnapshots: TrackedStoryArticleSnapshot[] = [];
                if (sid) {
                    const archive = await ArticleService.getTrackedStory(sid);
                    if (cancelled) return;
                    serverSnapshots = archive?.articles ?? [];
                }
                setCards(mergeTimeline(localSnapshots, serverSnapshots));
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

    const renderItem: ListRenderItem<TimelineCard> = useCallback(
        ({ item }) => {
            const article = cardToNewsArticle(item);
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
        (item: TimelineCard, index: number) => item.articleId || `snap-${index}`,
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
                data={cards}
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
