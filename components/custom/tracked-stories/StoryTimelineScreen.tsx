import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import AiDisclosureCaption from '@/components/custom/AiDisclosureCaption';
import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
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
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import { getGroupingRowsByIds } from '@/lib/database/services/article-suggestion-service';
import {
    advanceSeenWatermark,
    backfillSnapshotSource,
    getTrackedStoryById,
    markSeen,
    type SnapshotSourcePatch,
} from '@/lib/database/services/tracked-story-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import { deleteTrackedStoryById } from '@/lib/tracking/track-actions';
import { buildTimeline, type TimelineCard } from './merge-timeline';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
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

/**
 * Fill in the language / country / publisher a card is missing from the local
 * `article_suggestions` row of the same article, and persist what we resolve
 * back into the story's snapshots.
 *
 * Two kinds of card arrive bare: members snapshotted before those fields existed
 * on `TrackedStoryMemberSnapshot`, and the originating article of a freshly
 * followed story (seeded from a FeedbackSubject, which carries no language).
 * Without this they would never gain a language label or source flag — the
 * reconcile only snapshots members it has not seen before, so it never revisits
 * an existing one.
 *
 * Local read only (no network). Members already pruned out of the 24h suggestion
 * window simply stay bare — which is why the resolved fields are written back.
 */
async function hydrateSource(
    trackedStoryId: string,
    cards: TimelineCard[],
): Promise<TimelineCard[]> {
    const bare = cards.filter((c) => c.articleId && (!c.languageCode || !c.countryCode));
    if (bare.length === 0) return cards;

    try {
        const rows = await getGroupingRowsByIds(bare.map((c) => c.articleId));
        const patches = new Map<string, SnapshotSourcePatch>();
        for (const r of rows) {
            const patch: SnapshotSourcePatch = {
                languageCode: r.languageCode ?? undefined,
                countryCode: r.countryCode ?? undefined,
            };
            if (patch.languageCode || patch.countryCode) patches.set(r.id, patch);
        }
        if (patches.size === 0) return cards;

        void backfillSnapshotSource(trackedStoryId, patches);

        return cards.map((c) => {
            const p = patches.get(c.articleId);
            if (!p) return c;
            return {
                ...c,
                languageCode: c.languageCode ?? p.languageCode,
                countryCode: c.countryCode ?? p.countryCode,
            };
        });
    } catch (err) {
        logger.warn('[story-timeline] source hydrate failed', { error: String(err) });
        return cards;
    }
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
        original_language_code: card.languageCode,
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
 * A tracked story's timeline — the coverage gathered under its tracked topic,
 * newest-first. A followed story is just a topic: its members are the local
 * snapshots seeded at track time and grown by the topic reconcile each fetch
 * cycle (there is no server archive). Marks the story seen on every focus
 * (clears its unseen badge) and re-reads the local row on focus +
 * pull-to-refresh. The header renders the display label / headline (falling back
 * to the tracked title). Until the reconcile adds more members, a freshly
 * followed story shows only its originating article; a quiet note stands in when
 * empty.
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
    // EU AI Act Art. 50 transparency label (Group C1) — tracked separately from
    // `headline` because that state merges `llmHeadline ?? fallbackTitle` into
    // one string; the disclosure must only show when the displayed text is
    // actually the LLM-generated one.
    const [isLlmHeadline, setIsLlmHeadline] = useState(false);
    const [stableClusterId, setStableClusterId] = useState<string | null>(null);
    const [cards, setCards] = useState<TimelineCard[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    // Deleting retires the linked TOPIC as well as dropping the row — without
    // that the topic keeps pulling this story's coverage every fetch cycle for a
    // story the user believes they deleted. Then leave: the screen's subject is
    // gone.
    const handleConfirmDelete = useCallback(async () => {
        setConfirmDelete(false);
        await deleteTrackedStoryById(trackedStoryId);
        onBack();
    }, [trackedStoryId, onBack]);

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
                setIsLlmHeadline(!!story.llmHeadline);

                const localSnapshots = story.memberSnapshots ?? [];
                setStableClusterId(story.stableClusterId ?? null);

                const merged = await hydrateSource(trackedStoryId, buildTimeline(localSnapshots));
                if (!alive()) return;
                setCards(merged);

                // Successful build → advance the seen-pubDate watermark to the
                // newest pubDate on screen. Backfilled OLD articles (published
                // before this) then won't count toward the "N new" badge.
                const maxPub = Math.max(...merged.map((c) => c.pubDateMs || 0));
                if (maxPub > 0) void advanceSeenWatermark(trackedStoryId, maxPub);

                // A reconcile snapshot can arrive with a blank title (rare); hydrate
                // up to 6 still-blank cards via the quota-free getArticleById, then
                // patch them in. TTL'd-out articles simply stay blank.
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

    // Opens the reason view when Mera scored this article (see use-open-article).
    const openArticle = useOpenArticle();
    const handleArticlePress = useCallback(
        (articleId: string, stableClusterId: string | null) => {
            openArticle({ articleId, stableClusterId });
        },
        [openArticle],
    );

    const renderItem: ListRenderItem<TimelineCard> = useCallback(
        ({ item }) => {
            const article = cardToNewsArticle(item);
            return (
                <ArticleStandaloneCompactCard
                    article={article}
                    onPress={() => handleArticlePress(item.articleId, stableClusterId)}
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
        // No opaque fill: the AbstractGradientBackdrop below is the page background.
        <Box className="flex-1">
            {/* Page background. Must be the FIRST child so it paints behind
                everything else on the page. */}
            <AbstractGradientBackdrop />

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
                                size="xl"
                                numberOfLines={2}
                                className="text-white"
                            />
                        )}
                        {/* Short copy — see TrackedStoriesScreen: this is a followed-
                            story heading, and the header box is a narrow flex-1 slot
                            between the back and delete buttons.

                            `align="left"` so the caption sits flush under the START of
                            the title rather than drifting to the far right of the
                            header slot. The title is left-aligned; a right-hugging
                            caption read as belonging to the delete button beside it
                            instead of to the heading it discloses. */}
                        {isLlmHeadline && (
                            <AiDisclosureCaption
                                variant="compact"
                                text={t('aiDisclosure.short')}
                                align="left"
                            />
                        )}
                    </Box>
                    {/* Delete is the ONLY way to stop following a story (Q13):
                        the track button no longer untracks, because doing so
                        destroys everything saved here. Hence the confirm. */}
                    <Pressable
                        testID="story-timeline-delete"
                        onPress={() => setConfirmDelete(true)}
                        accessibilityRole="button"
                        accessibilityLabel={t('trackedStories.deleteStoryAction')}
                        hitSlop={8}
                        className="p-2"
                    >
                        <MaterialIcons name="delete-outline" size={24} color="#ffffff" />
                    </Pressable>
                </HStack>
            </VStack>

            {/* Delete confirmation — the same Gluestack Modal pattern the Saved
                list's delete uses. */}
            <Modal isOpen={confirmDelete} onClose={() => setConfirmDelete(false)}>
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader>
                        <Heading size="lg" className="text-white">
                            {t('trackedStories.deleteStoryConfirmTitle')}
                        </Heading>
                    </ModalHeader>
                    <ModalBody>
                        <Text size="sm" className="text-typography-300">
                            {t('trackedStories.deleteStoryConfirmBody')}
                        </Text>
                    </ModalBody>
                    <ModalFooter>
                        <Button
                            variant="outline"
                            action="secondary"
                            onPress={() => setConfirmDelete(false)}
                            className="mr-3"
                        >
                            <ButtonText>{t('common.cancel')}</ButtonText>
                        </Button>
                        <Button
                            action="negative"
                            onPress={handleConfirmDelete}
                            testID="story-timeline-delete-confirm"
                        >
                            <ButtonText>{t('trackedStories.deleteStoryAction')}</ButtonText>
                        </Button>
                    </ModalFooter>
                </ModalContent>
            </Modal>

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
