import type { ExportFormat } from '@/components/custom/saved-suggestions/export-and-share';
import type {
    ExportContentOptions,
    ExportWizardRow,
} from '@/components/custom/saved-suggestions/ExportWizardModal';
import { getLocalizedLanguageName } from '@/lib/algorithms/language-names';
import { ArticleService } from '@/lib/article-service';
import { getSuggestionByArticleId } from '@/lib/database/services/article-suggestion-reads';
import { getSavedSuggestionByServerId } from '@/lib/database/services/saved-article-suggestion-service';
import {
    advanceSeenWatermark,
    backfillSnapshotSource,
    getTrackedStoryById,
    markSeen,
    type SnapshotSourcePatch,
} from '@/lib/database/services/tracked-story-service';
import { calendarDaysAgo, formatDayMonth } from '@/lib/stats/visited-publications';
import { openArticle } from '@/lib/hooks/use-open-article';
import { exportDay } from '@/lib/saved-articles-export';
import {
    buildStoryJson,
    buildStoryMarkdown,
    toStoryExportRows,
    type StoryRetainedRow,
} from '@/lib/story-export';
import { deleteTrackedStoryById, disownStoryMember } from '@/lib/tracking/track-actions';
import { toastManager } from '@/lib/toast-manager';
import { useUserGeoLanguageContext } from '@/lib/user-context/user-geo-language-context';
import { buildTimeline, foldTimeline, type TimelineCard, type TimelineEntry } from './merge-timeline';
import logger from '@/lib/logger';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The list: a date heading over each day's coverage, even for one item
 *  (FinalRead #16). Export reads `cards`, never these rows. */
type TimelineRow = { kind: 'day'; key: string; label: string } | { kind: 'card'; entry: TimelineEntry };

/** Cap on the quota-free per-article title lookups fired to backfill blank-title
 *  cards from pre-fix archives (Part E stopgap). */
const MAX_TITLE_BACKFILL = 6;

/** Cap on the local row reads that fill a bare card's source fields. */
const MAX_SOURCE_HYDRATE = 30;

/**
 * Fill in the language / country / story key / original title a card is missing from the local
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
    const bare = cards
        .filter(
            (c) =>
                c.articleId &&
                (!c.languageCode || !c.countryCode || !c.storyKey || !c.titleOriginal),
        )
        .slice(0, MAX_SOURCE_HYDRATE);
    if (bare.length === 0) return cards;

    try {
        const rows = await Promise.all(bare.map((c) => getSuggestionByArticleId(c.articleId)));
        const patches = new Map<string, SnapshotSourcePatch>();
        rows.forEach((r, i) => {
            if (!r) return;
            const patch: SnapshotSourcePatch = {
                languageCode: r.language_code ?? undefined,
                countryCode: r.country_code ?? undefined,
                storyKey: r.storyKey ?? undefined,
                titleOriginal: r.title_original ?? undefined,
            };
            if (Object.values(patch).some(Boolean)) patches.set(bare[i].articleId, patch);
        });
        if (patches.size === 0) return cards;

        void backfillSnapshotSource(trackedStoryId, patches);

        return cards.map((c) => {
            const p = patches.get(c.articleId);
            if (!p) return c;
            return {
                ...c,
                languageCode: c.languageCode ?? p.languageCode,
                countryCode: c.countryCode ?? p.countryCode,
                storyKey: c.storyKey ?? p.storyKey,
                titleOriginal: c.titleOriginal ?? p.titleOriginal,
            };
        });
    } catch (err) {
        logger.warn('[story-timeline] source hydrate failed', { error: String(err) });
        return cards;
    }
}

export function useStoryTimelineScreen({
    trackedStoryId,
    onBack,
}: {
    trackedStoryId: string;
    onBack: () => void;
}) {
    const { t, i18n } = useTranslation();
    const appLanguage = i18n?.language ?? 'en';
    const [headline, setHeadline] = useState<string>('');
    // EU AI Act Art. 50 transparency label (Group C1) — tracked separately from
    // `headline` because that state merges `llmHeadline ?? fallbackTitle` into
    // one string; the disclosure must only show when the displayed text is
    // actually the LLM-generated one.
    const [isLlmHeadline, setIsLlmHeadline] = useState(false);
    const [stableClusterId, setStableClusterId] = useState<string | null>(null);
    const [cards, setCards] = useState<TimelineCard[]>([]);
    // The fold is a memo over the unfolded cards and the reader's context, never
    // part of the async load: the context arrives after the first load and the
    // head must be re-elected when it does.
    const userCtx = useUserGeoLanguageContext();
    const entries = useMemo(() => foldTimeline(cards, userCtx), [cards, userCtx]);
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
    const [confirmRemove, setConfirmRemove] = useState<TimelineEntry | null>(null);
    const [exportOpen, setExportOpen] = useState(false);
    // Export was picked in the ••• sheet: it opens once the sheet has gone.
    const exportPicked = useRef(false);
    // New since the reader last opened this page: the story's unseen count,
    // read BEFORE the visit stamps it (markSeen), so the header can say it.
    const [newAtOpen, setNewAtOpen] = useState(0);

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
        const entry = confirmRemove;
        setConfirmRemove(null);
        if (!entry?.head.articleId) return;
        // A folded entry is ONE story to the reader, so "not part of this story"
        // disowns every copy: left behind, the next copy would come back as head.
        const members = [entry.head, ...entry.copies];
        const gone = new Set(members.map((c) => c.articleId));
        setCards((prev) => prev.filter((c) => !gone.has(c.articleId)));
        const results = await Promise.all(
            members.map((c) => disownStoryMember(trackedStoryId, c.articleId)),
        );
        // Put back exactly the copies whose write failed.
        const failed = new Set(members.filter((_, i) => !results[i]).map((c) => c.articleId));
        if (failed.size > 0) {
            setCards((prev) => {
                const have = new Set(prev.map((c) => c.articleId));
                const back = members.filter((c) => failed.has(c.articleId) && !have.has(c.articleId));
                return [...prev, ...back].sort((a, b) => b.pubDateMs - a.pubDateMs);
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
                setHeadline(story.llmHeadline ?? story.topicText ?? story.fallbackTitle ?? '');
                setIsLlmHeadline(!!(story.llmHeadline ?? story.topicText));
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
    const onFocus = useCallback(() => {
        void (async () => {
            const before = await getTrackedStoryById(trackedStoryId);
            setNewAtOpen(before?.unseenCount ?? 0);
            await markSeen(trackedStoryId);
        })();
        void load();
        return () => {
            // Invalidate any in-flight load so it can't write state post-blur.
            runIdRef.current++;
        };
    }, [trackedStoryId, load]);

    // Opens the reason view when Mera scored this article, carrying the story
    // so the page lists its other copies (see use-open-article).
    const handleArticlePress = useCallback(
        (articleId: string, stableClusterId: string | null) => {
            void openArticle({ articleId, stableClusterId, trackedStoryId });
        },
        [trackedStoryId],
    );

    // Export: the same wizard as the Saved tab, every article ticked. Memoized
    // so a re-render while the wizard is open cannot re-tick what the reader
    // unticked (the wizard resets on open only).
    const exportRows = useMemo<ExportWizardRow[]>(
        () =>
            entries
                .map((e) => e.head)
                .filter((c) => !!c.articleId)
                .map((c) => ({
                    id: c.articleId,
                    title: c.title,
                    language: c.languageCode,
                })),
        [entries],
    );

    const buildExport = useCallback(
        async (chosenIds: string[], options: ExportContentOptions, format: ExportFormat) => {
            const chosen = new Set(chosenIds);
            // Heads only: what the reader sees. A folded copy is not exported.
            const members = entries.map((e) => e.head).filter((c) => chosen.has(c.articleId));
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
        [entries, headline, isLlmHeadline, t, appLanguage],
    );

    const handleExportFailed = useCallback(() => {
        toastManager.showError(t('savedExport.failedTitle'), t('savedExport.failedMessage'));
    }, [t]);

    const rows = useMemo<TimelineRow[]>(() => {
        const now = Date.now();
        const out: TimelineRow[] = [];
        let lastLabel = '';
        entries.forEach((entry, i) => {
            const card = entry.head;
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
            out.push({ kind: 'card', entry });
        });
        return out;
    }, [entries, t, appLanguage]);

    return {
        headline,
        isLlmHeadline,
        stableClusterId,
        cards,
        entries,
        isLoading,
        refreshing,
        emptyReason,
        followedSinceMs,
        menuOpen,
        setMenuOpen,
        stopPicked,
        confirmDelete,
        setConfirmDelete,
        confirmRemove,
        setConfirmRemove,
        exportOpen,
        setExportOpen,
        exportPicked,
        newAtOpen,
        handleConfirmDelete,
        handleConfirmRemove,
        load,
        onFocus,
        handleArticlePress,
        exportRows,
        buildExport,
        handleExportFailed,
        rows,
    };
}

export type { TimelineRow };
