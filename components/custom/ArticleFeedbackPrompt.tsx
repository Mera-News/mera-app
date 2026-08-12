// NOTE(app-rethink wave): still LIVE on the article/suggestion detail screens.
// This widget owns the detail screens' feedback STATE; the row itself is
// components/custom/cards/CardActionBar, which is now the one action row across
// cards, detail screens and the standalone card. New surfaces should render
// CardActionBar directly rather than growing a fourth copy.
import { Box } from '@/components/ui/box';
import CardActionBar from '@/components/custom/cards/CardActionBar';
import CardFeedbackSurface from '@/components/custom/cards/CardFeedbackSurface';
import { buildContextJson, type FeedbackSubject } from '@/components/custom/cards/feedback-subject';

import {
    getArticleVerdict,
    recordVerdictFeedback,
    removeArticleFeedback,
    updateFeedbackContextPath,
} from '@/lib/database/services/article-feedback-service';
import { resolveDetailFeedbackSubject, type DetailFeedbackContext } from '@/components/custom/news-detail/detail-feedback-context';
import { openFeedbackChatWithPath } from '@/lib/services/swipe-feedback';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import { useTrackButton } from '@/components/custom/tracked-stories/use-track-button';
import type { FeedbackNudge } from '@/lib/news-harness/feedback-tree';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ArticleFeedbackPromptProps {
    articleId: string;
    suggestionId?: string;
    title: string;
    /** The standalone article, when the screen has one (ArticleDetailScreen).
     *  Used ONLY as the fallback source of feedback context for an article with
     *  no local `article_suggestions` row — Explore, a tracked story, a shared
     *  link. A suggestion-backed screen passes nothing: the row is richer and is
     *  resolved here by articleId. */
    article?: NewsArticle | null;
    save?: {
        saved: boolean;
        onToggle: () => void;
    };
    /** When present, renders a self-managing "Track story" button. The subject
     *  carries the stable cluster id when the caller already knows it (suggestion
     *  clusters); otherwise `trackStoryFromSubject` resolves it lazily at track
     *  time via `getNewsClusterForArticle`. */
    track?: FeedbackSubject;
    share?: ShareArticleParams;
    /** The feedback tree's 'browse_related' nudge ("Show related coverage" on
     *  the paywall branch) fired. On a detail screen the related coverage is
     *  already on the page — its footer — so the host scrolls there rather than
     *  navigating anywhere. Omitted ⇒ the nudge just closes the surface. */
    onBrowseRelated?: () => void;
    /** The fact-check tick. `onStart` asks the SERVER for a check on this
     *  article (`requestArticleFactCheck`); the result lands in the detail
     *  screen's own `FactCheckPanel`, in place. It used to open the floating
     *  chat's claim picker instead, which could only answer "there's nothing
     *  specific to fact-check from this alone" — the AI-assisted path lives on
     *  as Mera AI's own "Quick fact check" chip. `state` is the caller's own
     *  `useFactCheck(articleId)` phase, mapped to the tick's three-signal
     *  vocabulary. Omitted ⇒ no tick, which is every surface without a place to
     *  show the result (the feed card), a locked free-tier user, and a reader
     *  who has turned fact checking off (`requestArticleFactCheck` no-ops in
     *  both of those too, but the caller still hides the tick so it is never a
     *  dead tap). */
    factCheck?: {
        onStart: () => void;
        state: 'none' | 'pending' | 'done';
    };
}

/**
 * Prominent feedback widget rendered directly under the reason box on the
 * article detail screens. The row is `CardActionBar` — the SAME borderless,
 * backgroundless row the feed cards use. It was a bespoke row of 48pt round,
 * primary-orange-outlined buttons until the user asked for card parity; see
 * CardActionBar's header for why that conversion had to take the row wholesale
 * (the circle was the only carrier of the D15 provisional state) and why a
 * liked article therefore reads green here now instead of orange.
 *
 * This component owns the STATE; CardActionBar is purely presentational:
 *   - Chat with Mera → opens the floating Mera chat for this article (plain
 *     open, no auto-sent message).
 *   - Like / Dislike → records the verdict (latest-wins, mutually exclusive) and
 *     FLOATS the inline feedback surface over the content above the row so the
 *     user can pick a reason. Re-tapping the same thumb removes the verdict +
 *     its feedback; the surface's × just hides it (keeps the verdict). The
 *     thumb stays coloured-but-HOLLOW until a reason is given: a bare verdict
 *     is provisional and gets discarded (D15), and a terminal tree leaf applies
 *     its persona actions on the spot (D16) — matching the For You feed.
 *
 * The feedback CONTEXT is resolved here, not passed in. See
 * news-detail/detail-feedback-context: the old `feedbackContext` prop was a
 * shim only one of the two detail screens ever filled in, and the cast that
 * carried it hid the omission.
 *   - Save (optional) → toggles the saved-for-later state (caller-owned).
 *   - Track (optional) → toggles story tracking.
 *   - Share (optional, only when the `share` prop has a URL).
 */
export const ArticleFeedbackPrompt: React.FC<ArticleFeedbackPromptProps> = ({
    articleId,
    suggestionId,
    title,
    article,
    save,
    track,
    share,
    onBrowseRelated,
    factCheck,
}) => {
    const [verdict, setVerdict] = useState<Verdict | null>(null);
    const [initialPath, setInitialPath] = useState<string[]>([]);
    // F3 — the fill discriminator, restored from the row rather than inferred
    // from `initialPath`: a path is written by a mere branch descent, so this
    // surface used to show an ABANDONED verdict (even one abandoned on the feed)
    // as a committed one, pixel-identical, across a process restart.
    const [committed, setCommitted] = useState(false);
    const [surfaceClosed, setSurfaceClosed] = useState(false);
    // Self-managing track state. `track` carries the stable id when known; the
    // fallback subject keeps the hook happy when the button is absent.
    const trackSubject: FeedbackSubject =
        track ?? { origin: 'article', surface: 'detail', articleId, title };
    const {
        tracked: storyTracked,
        onPress: onTrackPress,
        dialog: trackDialog,
    } = useTrackButton(trackSubject, !!track);
    const handleShare = useShareArticle(share);

    // Restore the stored verdict + tree path across remounts (leaving/reopening).
    useEffect(() => {
        let cancelled = false;
        getArticleVerdict(articleId)
            .then(({ verdict: v, path, committed: c }) => {
                if (cancelled) return;
                setVerdict(v);
                setInitialPath(path);
                setCommitted(!!c);
            })
            .catch(() => {
                /* non-fatal — default to no verdict */
            });
        return () => {
            cancelled = true;
        };
    }, [articleId]);

    // The real feedback context for this article, resolved from the local
    // suggestion row (preferred) or the article. Held as a PROMISE in a ref as
    // well as in state: a thumb tapped before the lookup lands must still
    // persist a full context_json — awaiting the same in-flight resolution is
    // what stops this regressing to the null snapshot it used to write.
    const [resolved, setResolved] = useState<DetailFeedbackContext | null>(null);
    const resolvingRef = useRef<Promise<DetailFeedbackContext> | null>(null);
    const ensureResolved = useCallback((): Promise<DetailFeedbackContext> => {
        if (!resolvingRef.current) {
            resolvingRef.current = resolveDetailFeedbackSubject({
                articleId,
                suggestionId,
                title,
                article,
            });
        }
        return resolvingRef.current;
    }, [articleId, suggestionId, title, article]);

    useEffect(() => {
        let cancelled = false;
        resolvingRef.current = null;
        void ensureResolved().then((ctx) => {
            if (!cancelled) setResolved(ctx);
        });
        return () => {
            cancelled = true;
        };
    }, [ensureResolved]);

    const surfaceSuggestion: ForYouSuggestion | null = resolved?.suggestion ?? null;

    // Record / flip / un-vote — mirrors the feed's onVerdict.
    const onVerdict = useCallback(
        (next: Verdict) => {
            if (verdict === next) {
                hapticLight();
                setVerdict(null);
                setInitialPath([]);
                setCommitted(false);
                setSurfaceClosed(false);
                void removeArticleFeedback(articleId, next);
                return;
            }
            hapticSuccess();
            setVerdict(next);
            setInitialPath([]);
            setCommitted(false);
            setSurfaceClosed(false);
            void (async () => {
                const ctx = await ensureResolved();
                await recordVerdictFeedback({
                    articleId,
                    suggestionId: ctx.subject.suggestionId,
                    sentiment: next,
                    title,
                    origin: ctx.subject.origin,
                    surface: ctx.subject.surface,
                    contextJson: buildContextJson(ctx.subject),
                });
            })();
        },
        [verdict, articleId, suggestionId, title, ensureResolved],
    );

    const handleLike = useCallback(() => onVerdict('like'), [onVerdict]);
    const handleDislike = useCallback(() => onVerdict('dislike'), [onVerdict]);

    const handleTreePathChanged = useCallback(
        (_s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
            setInitialPath(pathIds);
            void updateFeedbackContextPath(articleId, v, pathIds);
        },
        [articleId],
    );
    // A terminal leaf (the last input in the tree) — COMMIT, then close. This is
    // the only call that may fill the thumb, and it persists that fact so the
    // fill survives a remount and a process restart.
    const handleLeafCommitted = useCallback(
        (_s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
            setInitialPath(pathIds);
            setCommitted(true);
            void updateFeedbackContextPath(articleId, v, pathIds, true);
            setSurfaceClosed(true);
        },
        [articleId],
    );
    const handleInvokeMera = useCallback(
        (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
            // Escalating counts as context supplied, so it commits — a forward
            // promise: the chat stamps the row once its proposals are confirmed.
            setCommitted(true);
            void updateFeedbackContextPath(articleId, v, pathIds, true);
            void openFeedbackChatWithPath(s, v, pathIds);
            // Escalating to the chat is terminal — close the surface.
            setSurfaceClosed(true);
        },
        [articleId],
    );
    const handleCloseSurface = useCallback(() => setSurfaceClosed(true), []);
    // A nudge leaf. `handleLeafCommitted` has already run (the tree fires it
    // first), so the verdict is committed and the surface closed — this only
    // has to act on the suggestion.
    //
    // Everything except 'browse_related' is deliberately ignored here, and for
    // two different reasons: 'subscribe' is legacy (no current tree authors
    // one, and a stale cached tree offering it has nothing to open), while
    // 'manage_publication' is already HANDLED — it has one destination on every
    // surface and no per-host argument, so InlineFeedbackTree navigates before
    // calling this (see feedback-tree/open-publication-preferences). Adding a
    // second `router.push` here would double-push.
    const handleNudge = useCallback(
        (nudge: FeedbackNudge) => {
            if (nudge !== 'browse_related') return;
            onBrowseRelated?.();
        },
        [onBrowseRelated],
    );

    const handleChatPress = useCallback(() => {
        hapticMedium();
        useFloatingChatStore.getState().expand({
            kind: 'article-suggestion',
            articleId,
            suggestionId,
            articleTitle: title,
        });
    }, [articleId, suggestionId, title]);

    const handleSharePress = useCallback(() => {
        hapticLight();
        void handleShare();
    }, [handleShare]);

    // The surface can only render once the real context has resolved — there is
    // no half-built stand-in to fall back on any more, by design.
    const surfaceVisible = verdict != null && !surfaceClosed && surfaceSuggestion != null;
    // D15 — a verdict with no reason attached carries no promise: coloured but
    // HOLLOW, never filled. F3 — keyed off the COMMITTED flag, not
    // `initialPath`, which a branch descent also fills. See CardActionBar.
    const provisional = !committed;

    return (
        <Box className="relative">
            {trackDialog}
            {/* Floating feedback surface — anchored just above the action row
                (bottom: 100%), so it floats over the content above it. */}
            {surfaceVisible && verdict && surfaceSuggestion ? (
                <Box className="absolute left-0 right-0" style={{ bottom: '100%', marginBottom: 8 }}>
                    <CardFeedbackSurface
                        fill={false}
                        suggestion={surfaceSuggestion}
                        contextFallback={resolved?.contextFallback}
                        verdict={verdict}
                        initialPathIds={initialPath}
                        committed={committed}
                        onClose={handleCloseSurface}
                        onTreePathChanged={handleTreePathChanged}
                        onInvokeMera={handleInvokeMera}
                        onLeafCommitted={handleLeafCommitted}
                        onNudge={handleNudge}
                    />
                </Box>
            ) : null}

            {/* `horizontalPadding={0}`: the detail screens drop this widget into
                ArticleSuggestionContainer's `footer` slot, which already sits
                inside that screen's `p-5`. The old row added `px-1` on top of
                it; 0 is the honest value, and mirrors what ArticleSuggestionCard
                passes for ArticleCardBase's own padding. */}
            <CardActionBar
                verdict={verdict}
                provisional={provisional}
                saved={!!save?.saved}
                onLike={handleLike}
                onDislike={handleDislike}
                onAskMera={handleChatPress}
                onToggleSave={save?.onToggle}
                onTrack={track ? onTrackPress : undefined}
                tracked={storyTracked}
                onShare={share?.url ? handleSharePress : undefined}
                onFactCheck={factCheck?.onStart}
                factCheckState={factCheck?.state}
                horizontalPadding={0}
            />
        </Box>
    );
};

export default ArticleFeedbackPrompt;
