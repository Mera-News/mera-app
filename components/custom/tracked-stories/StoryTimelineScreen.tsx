import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { ActionSheetRow } from '@/components/custom/cards/ArticleOverflowMenu';
import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import type { ExportFormat } from '@/components/custom/saved-suggestions/export-and-share';
import ExportWizardModal, {
    type ExportContentOptions,
    type ExportWizardRow,
} from '@/components/custom/saved-suggestions/ExportWizardModal';
import { getLocalizedLanguageName } from '@/lib/language-names';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { Box } from '@/components/ui/box';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ArticleService } from '@/lib/article-service';
import { getGroupingRowsByIds } from '@/lib/database/services/article-suggestion-service';
import { getSavedSuggestionByServerId } from '@/lib/database/services/saved-article-suggestion-service';
import {
    advanceSeenWatermark,
    backfillSnapshotSource,
    getTrackedStoryById,
    markSeen,
    type SnapshotSourcePatch,
} from '@/lib/database/services/tracked-story-service';
import { hapticLight } from '@/lib/haptics';
import { calendarDaysAgo, formatDayMonth } from '@/lib/stats/visited-publications';
import { useColors } from '@/lib/theme/tokens';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import { exportDay } from '@/lib/saved-articles-export';
import {
    buildStoryJson,
    buildStoryMarkdown,
    toStoryExportRows,
    type StoryRetainedRow,
} from '@/lib/story-export';
import { deleteTrackedStoryById, disownStoryMember } from '@/lib/tracking/track-actions';
import { toastManager } from '@/lib/toast-manager';
import { buildTimeline, timelineCardToArticle, type TimelineCard } from './merge-timeline';
import logger from '@/lib/logger';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, ListRenderItem, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { notifyScrollTick } from '@/lib/visibility-tick';

/** A 44pt header button, numeric (never hitSlop). */
const HEADER_BUTTON = { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' } as const;

/** Pull-to-refresh spinner tint — matches FeedScreen's. */
const REFRESH_TINT = '#EDA77E';

interface StoryTimelineScreenProps {
    trackedStoryId: string;
    onBack: () => void;
}

/** The list: a date heading over each day's coverage, even for one item
 *  (FinalRead #16). Export reads `cards`, never these rows. */
type TimelineRow = { kind: 'day'; key: string; label: string } | { kind: 'card'; card: TimelineCard };

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
    const { t, i18n } = useTranslation();
    const appLanguage = i18n?.language ?? 'en';
    const insets = useSafeAreaInsets();
    const colors = useColors();
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
    // Why the list is empty, when it is not simply "no coverage yet". A load
    // that threw and a story deleted elsewhere both used to show the quiet
    // "no new coverage" note, which reads as a working story with nothing new.
    const [emptyReason, setEmptyReason] = useState<'quiet' | 'load-failed' | 'gone'>('quiet');
    const [followedSinceMs, setFollowedSinceMs] = useState<number | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    // Stop following was picked: its confirm opens once the sheet has gone.
    const stopPicked = useRef(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    // The card the user long-pressed and is being asked about. Holding the CARD
    // (not just its id) keeps the confirm addressable after the list re-renders.
    const [confirmRemove, setConfirmRemove] = useState<TimelineCard | null>(null);
    const [exportOpen, setExportOpen] = useState(false);

    // Deleting retires the linked TOPIC as well as dropping the row — without
    // that the topic keeps pulling this story's coverage every fetch cycle for a
    // story the user believes they deleted. Then leave: the screen's subject is
    // gone.
    const handleConfirmDelete = useCallback(async () => {
        setConfirmDelete(false);
        const deleted = await deleteTrackedStoryById(trackedStoryId);
        if (!deleted) {
            // Stay: leaving would tell the reader a story that still exists is
            // gone. The service never throws; false is its failure signal.
            toastManager.showError(t('errors.somethingWentWrong'), t('trackedStories.deleteFailed'));
            return;
        }
        onBack();
    }, [trackedStoryId, onBack, t]);

    /**
     * "Not part of this story" — drop ONE article from this timeline.
     *
     * Removes the member SNAPSHOT and deliberately LEAVES the member id on the
     * row. The two are not interchangeable:
     *   - `member_snapshots_json` is what this screen renders (buildTimeline).
     *   - `member_article_ids` is the reconcile's already-considered ledger
     *     (tracked-story-reconcile::reconcileByTopic diffs candidates against
     *     it).
     * Drop the id too and the next feed sync re-adds the article, because the
     * topic still matches it and the dedupe no longer remembers it. Keeping the
     * id is what makes the removal stick, and it needs no tombstone list and no
     * schema change. The id ages off the 30-cap only after 30 newer members,
     * long past the suggestion window that could resurrect it.
     *
     * Optimistic: the row leaves the list immediately, and the write is a
     * never-throwing local update. NOT reloading afterwards is deliberate — a
     * reload would re-run the watermark stamp for no reason.
     *
     * Known, accepted: `matchesTrackedQuery` still matches by member article id,
     * so opening this article from the feed keeps reporting "already following".
     * The alternative (dropping the id) resurrects the card, which is worse.
     */
    const handleConfirmRemove = useCallback(async () => {
        const card = confirmRemove;
        setConfirmRemove(null);
        if (!card?.articleId) return;
        let removedAt = -1;
        setCards((prev) => {
            removedAt = prev.findIndex((c) => c.articleId === card.articleId);
            return prev.filter((c) => c.articleId !== card.articleId);
        });
        const removed = await disownStoryMember(trackedStoryId, card.articleId);
        if (!removed) {
            // Roll the optimistic removal back into its old slot.
            setCards((prev) => {
                if (prev.some((c) => c.articleId === card.articleId)) return prev;
                const next = prev.slice();
                next.splice(removedAt < 0 ? next.length : Math.min(removedAt, next.length), 0, card);
                return next;
            });
            toastManager.showError(t('errors.somethingWentWrong'), t('trackedStories.removeFailed'));
        }
    }, [confirmRemove, trackedStoryId, t]);

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
                if (!story) {
                    // Deleted elsewhere (another screen, or a sync). Say so.
                    setCards([]);
                    setEmptyReason('gone');
                    return;
                }
                setEmptyReason('quiet');
                setHeadline(story.llmHeadline ?? story.fallbackTitle ?? '');
                setIsLlmHeadline(!!story.llmHeadline);
                setFollowedSinceMs(story.createdAt ? story.createdAt.getTime() : null);

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
                if (alive()) setEmptyReason('load-failed');
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

    // Export: the same wizard as the Saved tab, every article ticked. Memoized
    // so a re-render while the wizard is open cannot re-tick what the reader
    // unticked (the wizard resets on open only).
    const exportRows = useMemo<ExportWizardRow[]>(
        () =>
            cards
                .filter((c) => !!c.articleId)
                .map((c) => ({
                    id: c.articleId,
                    title: c.title,
                    language: c.languageCode,
                })),
        [cards],
    );

    const buildExport = useCallback(
        async (chosenIds: string[], options: ExportContentOptions, format: ExportFormat) => {
            const chosen = new Set(chosenIds);
            const members = cards.filter((c) => chosen.has(c.articleId));
            // Links and notes live on the story's retention rows, not its
            // snapshots (see lib/story-export.ts). Local reads only, at most
            // one per member.
            const kept = await Promise.all(
                members.map((m) => getSavedSuggestionByServerId(m.articleId).catch(() => null)),
            );
            const retainedById = new Map<string, StoryRetainedRow>();
            kept.forEach((row, i) => {
                if (row) retainedById.set(members[i].articleId, row);
            });
            const rows = toStoryExportRows(members, retainedById, options);
            // A story with neither headline falls back to its newest article.
            const docHeadline = headline || rows[0]?.title || t('trackedStories.title');
            return format === 'markdown'
                ? buildStoryMarkdown(rows, {
                      headline: docHeadline,
                      headlineAiLabel: isLlmHeadline ? t('aiDisclosure.short') : undefined,
                      docExported: t('savedExport.docExported', { date: exportDay() }),
                      reasonLabel: t('savedExport.docReasonLabel'),
                      languageName: (code) => getLocalizedLanguageName(code, appLanguage),
                  })
                : buildStoryJson(
                      rows,
                      { headline: docHeadline, headlineAiGenerated: isLlmHeadline },
                      options,
                  );
        },
        [cards, headline, isLlmHeadline, t, appLanguage],
    );

    const handleExportFailed = useCallback(() => {
        toastManager.showError(t('savedExport.failedTitle'), t('savedExport.failedMessage'));
    }, [t]);

    const rows = useMemo<TimelineRow[]>(() => {
        const now = Date.now();
        const out: TimelineRow[] = [];
        let lastLabel = '';
        cards.forEach((card, i) => {
            if (card.pubDateMs) {
                const days = calendarDaysAgo(card.pubDateMs, now);
                const label =
                    days <= 0
                        ? t('common.today')
                        : days === 1
                          ? t('common.yesterday')
                          : formatDayMonth(card.pubDateMs, appLanguage);
                if (label !== lastLabel) {
                    out.push({ kind: 'day', key: `day-${i}-${label}`, label });
                    lastLabel = label;
                }
            }
            out.push({ kind: 'card', card });
        });
        return out;
    }, [cards, t, appLanguage]);

    const renderCard = useCallback(
        (item: TimelineCard) => {
            const article = timelineCardToArticle(item);
            const askRemove = () => {
                hapticLight();
                setConfirmRemove(item);
            };
            return (
                <ArticleStandaloneCompactCard
                    testID={`story-timeline-card-${item.articleId}`}
                    article={article}
                    onPress={() => handleArticlePress(item.articleId, stableClusterId)}
                    // Disowning a card: long-press (kept, matching the
                    // Followed-stories list one screen up) and the ••• menu's
                    // "Not part of this story", both through the same confirm.
                    onLongPress={askRemove}
                    menuExtraItems={[
                        {
                            key: 'remove-from-story',
                            label: t('trackedStories.removeMemberAction'),
                            icon: 'remove-circle-outline',
                            testID: 'menu-remove-from-story',
                            run: askRemove,
                        },
                    ]}
                    subjectExtras={{
                        surface: 'tracked',
                        stableClusterId: stableClusterId ?? undefined,
                    }}
                />
            );
        },
        [handleArticlePress, stableClusterId, t],
    );

    const renderItem: ListRenderItem<TimelineRow> = useCallback(
        ({ item }) =>
            item.kind === 'day' ? (
                <Text
                    accessibilityRole="header"
                    style={{ color: colors.ink3, fontSize: 13, fontWeight: '600', marginTop: 8, marginBottom: 8 }}
                >
                    {item.label}
                </Text>
            ) : (
                renderCard(item.card)
            ),
        [renderCard, colors.ink3],
    );

    const keyExtractor = useCallback(
        (item: TimelineRow, index: number) =>
            item.kind === 'day' ? item.key : item.card.articleId || `snap-${index}`,
        [],
    );

    // What comes next (FinalRead #16): under the coverage, and on its own
    // when there is none yet.
    const nextNote = (
        <HStack className="items-center px-1 py-4" space="sm" testID="story-timeline-next">
            <MaterialIcons name="history" size={18} color={colors.ink3} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
            <Text size="sm" style={{ color: colors.ink3, flex: 1 }}>
                {t('trackedStories.nextNote')}
            </Text>
        </HStack>
    );

    const ListEmpty = isLoading ? (
        <Box className="items-center justify-center py-20">
            <Spinner size="large" />
        </Box>
    ) : emptyReason === 'quiet' ? (
        nextNote
    ) : (
        <Box className="items-center justify-center py-20 px-8" testID={`story-timeline-${emptyReason}`}>
            <MaterialIcons name="error-outline" size={40} color="#9CA3AF" />
            <Text size="sm" className="text-typography-400 text-center mt-4">
                {emptyReason === 'gone'
                    ? t('articleDetail.storyUnavailable')
                    : t('trackedStories.timelineLoadFailed')}
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
                        accessibilityLabel={t('common.back')}
                        style={HEADER_BUTTON}
                    >
                        <MaterialIcons name="arrow-back" size={24} color={colors.ink} />
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
                        {/* Followed since, and the AI disclosure when the
                            headline is Mera's (EU AI Act Art. 50). Wraps, never truncates. */}
                        {followedSinceMs || isLlmHeadline ? (
                            <Text size="xs" style={{ color: colors.ink3, marginTop: 2 }}>
                                {[
                                    followedSinceMs
                                        ? t('trackedStories.followedSince', {
                                              date: formatDayMonth(followedSinceMs, appLanguage),
                                          })
                                        : null,
                                    isLlmHeadline ? t('trackedStories.headlinesByMera') : null,
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </Text>
                        ) : null}
                    </Box>
                    {/* Export. Hidden until there is something to export, so
                        it never opens an empty wizard. */}
                    {!isLoading && exportRows.length > 0 && (
                        <Pressable
                            testID="story-timeline-share"
                            onPress={() => setExportOpen(true)}
                            accessibilityRole="button"
                            accessibilityLabel={t('storyExport.shareA11y')}
                            style={HEADER_BUTTON}
                        >
                            <MaterialIcons name="ios-share" size={24} color={colors.ink} />
                        </Pressable>
                    )}
                    {/* Stopping is the ONLY way to unfollow a story (Q13): it
                        destroys everything saved here, hence the confirm. */}
                    <Pressable
                        testID="story-timeline-more"
                        onPress={() => setMenuOpen(true)}
                        accessibilityRole="button"
                        accessibilityLabel={t('articleMenu.openA11y')}
                        style={HEADER_BUTTON}
                    >
                        <MaterialIcons name="more-horiz" size={24} color={colors.ink} />
                    </Pressable>
                </HStack>
            </VStack>

            <BottomSheet
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                // The confirm opens once the sheet has fully gone: iOS refuses
                // a second modal over one still leaving.
                onClosed={() => {
                    if (!stopPicked.current) return;
                    stopPicked.current = false;
                    setConfirmDelete(true);
                }}
                testID="story-timeline-menu"
            >
                <ActionSheetRow
                    testID="story-timeline-stop"
                    label={t('trackedStories.stopFollowing')}
                    icon="remove-circle-outline"
                    destructive
                    onPress={() => {
                        stopPicked.current = true;
                        setMenuOpen(false);
                    }}
                />
            </BottomSheet>

            <ConfirmDialog
                open={confirmDelete}
                title={t('trackedStories.stopFollowingConfirmTitle')}
                body={t('trackedStories.stopFollowingConfirmBody')}
                confirmLabel={t('trackedStories.stopFollowing')}
                destructive
                onConfirm={handleConfirmDelete}
                onCancel={() => setConfirmDelete(false)}
                testID="story-timeline-delete"
            />

            {/* "Not part of this story": drops ONE article and leaves the
                story followed. */}
            <ConfirmDialog
                open={!!confirmRemove}
                title={t('trackedStories.removeMemberConfirmTitle')}
                body={t('trackedStories.removeMemberConfirmBody')}
                confirmLabel={t('trackedStories.removeMemberAction')}
                destructive
                onConfirm={handleConfirmRemove}
                onCancel={() => setConfirmRemove(null)}
                testID="story-timeline-card-remove"
            />

            <ExportWizardModal
                isOpen={exportOpen}
                onClose={() => setExportOpen(false)}
                rows={exportRows}
                buildContent={buildExport}
                onFailed={handleExportFailed}
                dialogTitle={t('storyExport.shareDialogTitle')}
                reasonHint={t('storyExport.includeReasonHint')}
                testIDPrefix="story-export"
                initiallyAllSelected
                fileBaseName="mera-story"
            />

            <FlatList
                // Rows below the first screen ask for their translation only
                // when a scroll tick finds them on screen (lib/visibility-tick).
                onScroll={notifyScrollTick}
                scrollEventThrottle={16}
                onContentSizeChange={notifyScrollTick}
                data={rows}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                ListEmptyComponent={ListEmpty}
                ListFooterComponent={cards.length > 0 ? nextNote : null}
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
                    // F35: the same 16pt side margins as Explore's list; the
                    // cards ran edge to edge.
                    paddingHorizontal: 16,
                    paddingBottom: insets.bottom + 40,
                    flexGrow: 1,
                }}
                showsVerticalScrollIndicator={false}
            />
        </Box>
    );
};

export default StoryTimelineScreen;
