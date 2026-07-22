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
    advanceSeenWatermark,
    getTrackedStoryById,
    markSeen,
} from '@/lib/database/services/tracked-story-service';
import type { NewsArticle, TrackedStoryArticleSnapshot } from '@/lib/generated/graphql-types';
import { mergeTimeline, type TimelineCard } from './merge-timeline';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Pull-to-refresh spinner tint — matches FeedScreen's. */
const REFRESH_TINT = '#EDA77E';

interface StoryTimelineScreenProps {
    trackedStoryId: string;
    onBack: () => void;
}

/** Cap on the quota-free per-article title lookups fired to backfill blank-title
 *  cards from pre-fix archives (Part E stopgap). */
const MAX_TITLE_BACKFILL = 6;

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
 * cluster id, newest-first. Marks the story seen on every focus (clears its
 * unseen badge) and refetches the server archive on every focus + on
 * pull-to-refresh, so re-opening a story always shows the freshest coverage.
 * The header renders the LLM headline (falling back to the tracked title). When
 * no archive exists yet (never resolved a stable id, or the story ended before
 * coverage was captured), a quiet note stands in for the list.
 *
 * After each SUCCESSFUL load, the newest pubDate on screen is stamped as the
 * story's seen watermark (schema v44) so the reconcile counts only members
 * published after it toward the "N new" badge — backfilled OLD articles no
 * longer inflate the count.
 */
const StoryTimelineScreen: React.FC<StoryTimelineScreenProps> = ({ trackedStoryId, onBack }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [headline, setHeadline] = useState<string>('');
    const [stableClusterId, setStableClusterId] = useState<string | null>(null);
    const [cards, setCards] = useState<TimelineCard[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);

    // Monotonic run token — each load() invalidates prior in-flight runs, and
    // the focus-effect cleanup bumps it so a load resolving after blur/unmount
    // never writes stale state.
    const runIdRef = useRef(0);

    const load = useCallback(
        async (opts?: { isRefresh?: boolean }) => {
            const runId = ++runIdRef.current;
            const alive = () => runId === runIdRef.current;
            if (opts?.isRefresh) setRefreshing(true);
            else setIsLoading(true);

            try {
                const story = await getTrackedStoryById(trackedStoryId);
                if (!alive()) return;
                if (!story) return;
                setHeadline(story.llmHeadline ?? story.fallbackTitle ?? '');

                const localSnapshots = story.memberSnapshots ?? [];
                const sid = story.stableClusterId;
                setStableClusterId(sid ?? null);

                let serverSnapshots: TrackedStoryArticleSnapshot[] = [];
                if (sid) {
                    const archive = await ArticleService.getTrackedStory(sid);
                    if (!alive()) return;
                    serverSnapshots = archive?.articles ?? [];
                }
                const merged = mergeTimeline(localSnapshots, serverSnapshots);
                setCards(merged);

                // Successful merge → advance the seen-pubDate watermark to the
                // newest pubDate on screen. Backfilled OLD articles (published
                // before this) then won't count toward the "N new" badge.
                const maxPub = Math.max(...merged.map((c) => c.pubDateMs || 0));
                if (maxPub > 0) void advanceSeenWatermark(trackedStoryId, maxPub);

                // Stopgap for pre-fix archives that persisted null titles: hydrate
                // up to 6 still-blank cards via the quota-free getArticleById, then
                // patch them in. (The durable server-side re-hydration ships in
                // parallel; TTL'd-out articles simply stay blank.)
                const missing = merged
                    .filter((c) => c.articleId && !c.title.trim())
                    .slice(0, MAX_TITLE_BACKFILL);
                if (missing.length > 0) {
                    const patches = await Promise.all(
                        missing.map(async (c) => {
                            try {
                                const art = await ArticleService.getArticleById(c.articleId);
                                const title =
                                    art?.title_en_internal_only ?? art?.title ?? '';
                                return title.trim()
                                    ? { articleId: c.articleId, title: title.trim() }
                                    : null;
                            } catch {
                                return null;
                            }
                        }),
                    );
                    if (!alive()) return;
                    const patchMap = new Map(
                        patches
                            .filter((p): p is { articleId: string; title: string } => p !== null)
                            .map((p) => [p.articleId, p.title]),
                    );
                    if (patchMap.size > 0) {
                        setCards((prev) =>
                            prev.map((c) =>
                                patchMap.has(c.articleId)
                                    ? { ...c, title: patchMap.get(c.articleId)! }
                                    : c,
                            ),
                        );
                    }
                }
            } catch (err) {
                // Failed load — deliberately do NOT advance the watermark.
                logger.captureException(err, {
                    tags: { screen: 'StoryTimelineScreen', method: 'load' },
                    extra: { trackedStoryId },
                });
            } finally {
                if (alive()) {
                    setIsLoading(false);
                    setRefreshing(false);
                }
            }
        },
        [trackedStoryId],
    );

    // Refetch on every focus (not just first mount) so re-opening a story shows
    // the freshest coverage. markSeen clears the unseen badge as it opens.
    useFocusEffect(
        useCallback(() => {
            void markSeen(trackedStoryId);
            void load();
            return () => {
                // Invalidate any in-flight load so it can't write state post-blur.
                runIdRef.current++;
            };
        }, [trackedStoryId, load]),
    );

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
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => load({ isRefresh: true })}
                        tintColor={REFRESH_TINT}
                        colors={[REFRESH_TINT]}
                    />
                }
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
