// NOTE(app-rethink wave): still LIVE on the article/suggestion detail screens.
// This widget owns the detail screens' feedback STATE; the row itself is
// components/custom/cards/CardActionBar, which is now the one action row across
// cards, detail screens and the standalone card. New surfaces should render
// CardActionBar directly rather than growing a fourth copy.
import { Box } from '@/components/ui/box';
import CardActionBar from '@/components/custom/cards/CardActionBar';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
import { buildContextJson, type FeedbackSubject } from '@/components/custom/cards/feedback-subject';

import {
    getArticleVerdict,
    markFeedbackProcessedFor,
    recordVerdictFeedback,
    removeArticleFeedback,
    updateFeedbackContextPath,
} from '@/lib/database/services/article-feedback-service';
import { resolveDetailFeedbackSubject, type DetailFeedbackContext } from '@/components/custom/news-detail/detail-feedback-context';
import { openFeedbackChatWithPath } from '@/lib/services/swipe-feedback';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { Verdict } from '@/lib/stores/feed-order-store';
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
    /** The subject for the ••• menu's Follow item. The subject
     *  carries the stable cluster id when the caller already knows it (suggestion
     *  clusters); otherwise `trackStoryFromSubject` resolves it lazily at track
     *  time via `getNewsClusterForArticle`. */
    track?: FeedbackSubject;
    share?: ShareArticleParams;
    /** The feedback tree's 'browse_related' nudge ("Show related coverage" on
     *  the paywall branch) fired. On a detail screen the related coverage is
     *  already on the page — its footer — so the host scrolls there rather than
     *  navigating anywhere. Omitted ⇒ the nudge just closes the sheet. */
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
    /** The publisher's name, for the ••• menu's "Fewer from <source>". */
    publicationName?: string | null;
}

/**
 * Prominent feedback widget rendered directly under the reason box on the
 * article detail screens. The row is `CardActionBar` — the SAME borderless,
 * backgroundless row the feed cards use. It was a bespoke row of 48pt round,
 * primary-orange-outlined buttons until the user asked for card parity; see
 * CardActionBar's header for why a liked article reads green here instead of
 * orange.
 *
 * This component owns the STATE; CardActionBar is purely presentational:
 *   - Like / Dislike → records the verdict (latest-wins, mutually exclusive),
 *     fills the thumb at once, then opens the shared ••• sheet at that
 *     verdict's tree root, with no Back row, as optional refinement: the same
 *     sheet and tree as every other surface (owner: one behaviour). Cancel
 *     keeps the verdict. Re-tapping the same thumb removes it and opens
 *     nothing. A bare verdict is stored and shown but never reaches the digest
 *     (D15); a terminal tree leaf applies its persona actions on the spot
 *     (D16).
 *
 * The feedback CONTEXT is resolved here, not passed in. See
 * news-detail/detail-feedback-context: the old `feedbackContext` prop was a
 * shim only one of the two detail screens ever filled in, and the cast that
 * carried it hid the omission.
 *   - Save (optional) → toggles the saved-for-later state (caller-owned).
 *   - ••• → the shared article menu (Ask Mera, Follow, Check for fact checks,
 *     Google Translate, Fewer from, Report a bug).
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
    publicationName,
}) => {
    const [verdict, setVerdict] = useState<Verdict | null>(null);
    // Follow lives in the ••• menu, which owns its state and dialogs. `track`
    // carries the stable cluster id when known; the fallback keeps the menu's
    // subject whole when a caller passes none.
    const trackSubject: FeedbackSubject =
        track ?? { origin: 'article', surface: 'detail', articleId, title };
    const handleShare = useShareArticle(share);

    // D3: the shared ••• menu, detail flavour (no "Open on source": the
    // screen's primary button already does that). Ask Mera, Follow and the
    // fact-check tick move into it; a check already answered is not offered
    // again, since asking twice cannot produce a different answer.
    const menuSubject = React.useMemo<FeedbackSubject>(
        () => ({ ...trackSubject, publicationName: publicationName ?? trackSubject.publicationName ?? null }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [articleId, suggestionId, title, publicationName, track?.stableClusterId],
    );

    // Restore the stored verdict + tree path across remounts (leaving/reopening).
    useEffect(() => {
        let cancelled = false;
        getArticleVerdict(articleId)
            .then(({ verdict: v }) => {
                if (cancelled) return;
                setVerdict(v);
            })
            .catch(() => {
                /* non-fatal — default to no verdict */
            });
        return () => {
            cancelled = true;
        };
    }, [articleId]);

    // The real feedback context for this article, resolved from the local
    // suggestion row (preferred) or the article. Held as a PROMISE in a ref:
    // a thumb tapped before the lookup lands must still
    // persist a full context_json — awaiting the same in-flight resolution is
    // what stops this regressing to the null snapshot it used to write.
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

    // Warm the resolution on mount (and on a new article), so a thumb or the
    // sheet's tree rarely waits for it.
    useEffect(() => {
        resolvingRef.current = null;
        void ensureResolved();
    }, [ensureResolved]);

    // Record / flip / un-vote — mirrors the feed's onVerdict.
    const onVerdict = useCallback(
        (next: Verdict) => {
            if (verdict === next) {
                hapticLight();
                setVerdict(null);
                void removeArticleFeedback(articleId, next);
                return;
            }
            hapticSuccess();
            setVerdict(next);
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

    // A tree leaf settled. ORDER MATTERS: a committed path write re-opens the
    // row for the digest (processed_at = null) and lands AFTER applyLeafActions
    // stamped it spent, so re-stamp after the write when the leaf applied
    // something, or the 3-hourly digest applies it twice.
    const handleLeafPicked = useCallback(
        (v: Verdict, pathIds: string[], appliedCount: number, leafCommitted: boolean) => {
            void (async () => {
                await updateFeedbackContextPath(articleId, v, pathIds, leafCommitted);
                if (appliedCount > 0) await markFeedbackProcessedFor(articleId, v);
            })();
        },
        [articleId],
    );
    // An openChat leaf. Escalating counts as context supplied, so it commits:
    // a forward promise, the chat stamps the row once its proposals are
    // confirmed. The hand-off carries the verdict and the tapped breadcrumb.
    const handleFeedbackChat = useCallback(
        (v: Verdict, pathIds: string[]) => {
            void updateFeedbackContextPath(articleId, v, pathIds, true);
            void ensureResolved().then((ctx) => openFeedbackChatWithPath(ctx.suggestion, v, pathIds));
        },
        [articleId, ensureResolved],
    );
    // The tree gates and resolves against the SAME resolved subject the verdict
    // row persists, plus what only the standalone article knows (its place).
    const resolveTreeContext = useCallback(async (): Promise<LocalFeedbackContext> => {
        const ctx = await ensureResolved();
        // Required at call time: the context build reaches the database.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { buildOverlayContext } = require('@/components/custom/cards/overlay-context') as typeof import('@/components/custom/cards/overlay-context');
        return buildOverlayContext(
            { ...ctx.subject, entities: ctx.subject.entities ?? ctx.suggestion.entities ?? undefined },
            ctx.contextFallback,
        );
    }, [ensureResolved]);

    const menu = useArticleMenu({
        surface: 'detail',
        subject: menuSubject,
        articleUrl: share?.url,
        languageCode: share?.sourceLanguage,
        onCheckFacts:
            factCheck && factCheck.state !== 'done'
                ? () => {
                      factCheck.onStart();
                      return true;
                  }
                : undefined,
        onLeafPicked: handleLeafPicked,
        onFeedbackChat: handleFeedbackChat,
        onBrowseRelated: onBrowseRelated ? () => onBrowseRelated() : undefined,
        resolveTreeContext,
    });

    // A thumb records the verdict, then opens the sheet at that tree's root.
    // A second tap on the recorded thumb only removes it.
    const tapThumb = useCallback(
        (next: Verdict) => {
            const opensTree = verdict !== next;
            onVerdict(next);
            if (opensTree) menu.openFeedback(next);
        },
        [verdict, onVerdict, menu],
    );
    const handleLike = useCallback(() => tapThumb('like'), [tapThumb]);
    const handleDislike = useCallback(() => tapThumb('dislike'), [tapThumb]);

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

    return (
        // No custom actions here, unlike the cards: this box is not a
        // Pressable, so every button in the row (••• included) is its own
        // VoiceOver element already.
        <Box className="relative">
            {menu.element}
            {/* `horizontalPadding={0}`: the detail screens drop this widget into
                ArticleSuggestionContainer's `footer` slot, which already sits
                inside that screen's `p-5`. The old row added `px-1` on top of
                it; 0 is the honest value, and mirrors what ArticleSuggestionCard
                passes for ArticleCardBase's own padding. */}
            <CardActionBar
                verdict={verdict}
                saved={!!save?.saved}
                onLike={handleLike}
                onDislike={handleDislike}
                onAskMera={handleChatPress}
                onToggleSave={save?.onToggle}
                onShare={share?.url ? handleSharePress : undefined}
                onFactCheck={factCheck?.onStart}
                factCheckState={factCheck?.state}
                onOverflow={menu.open}
                horizontalPadding={0}
            />
        </Box>
    );
};

export default ArticleFeedbackPrompt;
