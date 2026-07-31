// NOTE(app-rethink wave): still LIVE on the article/suggestion detail screens.
// New card/feed code should use components/custom/cards/ArticleActionsRow (the
// origin-aware universal actions row) instead of this widget.
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import MeraLogo from '@/components/custom/MeraLogo';
import CardFeedbackSurface from '@/components/custom/cards/CardFeedbackSurface';
import { Pressable } from '@/components/ui/pressable';
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
import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

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
}

// Primary-orange accent for the three feedback buttons. Dark-locked: these
// stay orange-on-dark regardless of app theme. (Close to primary-500 but not an
// exact token match, so the hex is used directly.)
const PRIMARY = '#EDA77E';
// Icon color when a button is in its filled/selected state — dark for contrast
// against the orange fill.
const SELECTED_ICON = '#1a1a1a';
// D15 — the PROVISIONAL treatment (see CardActionBar): recorded, but with no
// reason attached, so it is tinted rather than filled.
const PROVISIONAL_BG = 'rgba(237,167,126,0.18)';

// Slightly larger than the original 19/45 — the row lost the Mera button on the
// suggestion detail screen, so the survivors get more room and `justify-evenly`
// spreads them across the freed width.
const ICON_SIZE = 22;
const BUTTON_SIZE = 48;

/**
 * Prominent feedback widget rendered directly under the reason box on the
 * article detail screens. Single row of round, primary-orange-outlined
 * buttons spread evenly across the width:
 *   - Chat with Mera → opens the floating Mera chat for this article (plain
 *     open, no auto-sent message).
 *   - Like / Dislike → records the verdict (latest-wins, mutually exclusive) and
 *     FLOATS the inline feedback surface over the content above the row so the
 *     user can pick a reason. Re-tapping the same thumb removes the verdict +
 *     its feedback; the surface's × just hides it (keeps the verdict). The
 *     thumb stays tinted-not-filled until a reason is given: a bare verdict is
 *     provisional and gets discarded (D15), and a terminal tree leaf applies
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
}) => {
    const { t } = useTranslation();
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
    // D15 — a verdict with no reason attached carries no promise: coloured
    // outline + tint, never the filled treatment. F3 — keyed off the COMMITTED
    // flag, not `initialPath`, which a branch descent also fills. See CardActionBar.
    const provisional = !committed;

    // A single action button. `selected` fills it (filled/orange treatment);
    // `provisionalFill` is the softer "recorded, not yet explained" tint.
    const renderButton = (
        icon: React.ReactNode,
        label: string,
        onPress: () => void,
        selected: boolean,
        testID?: string,
        provisionalFill = false,
    ) => (
        <Pressable
            testID={testID}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            className="items-center justify-center rounded-full"
            style={{
                width: BUTTON_SIZE,
                height: BUTTON_SIZE,
                backgroundColor: selected
                    ? PRIMARY
                    : provisionalFill
                      ? PROVISIONAL_BG
                      : 'transparent',
                borderWidth: 1.75,
                borderColor: PRIMARY,
            }}
        >
            {icon}
        </Pressable>
    );

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
                    />
                </Box>
            ) : null}

            <HStack className="items-center justify-evenly px-1 py-3">
                {/* Mera — the single Ask-Mera affordance on this screen. It
                    briefly moved onto the rationale block above; that was
                    reverted, so it lives here unconditionally, matching the
                    card action bar. */}
                <Pressable
                    testID="card-action-mera"
                    onPress={handleChatPress}
                    accessibilityRole="button"
                    accessibilityLabel={t('swipeFeed.askMera')}
                    className="items-center justify-center rounded-full"
                    style={{
                        width: BUTTON_SIZE,
                        height: BUTTON_SIZE,
                        backgroundColor: 'transparent',
                        borderWidth: 1.75,
                        borderColor: PRIMARY,
                    }}
                >
                    <MeraLogo size={30} />
                </Pressable>
                {renderButton(
                    <MaterialIcons
                        name="thumb-up"
                        size={ICON_SIZE}
                        color={verdict === 'like' && !provisional ? SELECTED_ICON : PRIMARY}
                    />,
                    t('articleFeedback.likeLabel'),
                    handleLike,
                    verdict === 'like' && !provisional,
                    'card-action-like',
                    verdict === 'like' && provisional,
                )}
                {renderButton(
                    <MaterialIcons
                        name="thumb-down"
                        size={ICON_SIZE}
                        color={verdict === 'dislike' && !provisional ? SELECTED_ICON : PRIMARY}
                    />,
                    t('articleFeedback.dislikeLabel'),
                    handleDislike,
                    verdict === 'dislike' && !provisional,
                    'card-action-dislike',
                    verdict === 'dislike' && provisional,
                )}
                {save ? renderButton(
                    <MaterialIcons
                        name={save.saved ? 'bookmark' : 'bookmark-border'}
                        size={ICON_SIZE}
                        color={save.saved ? SELECTED_ICON : PRIMARY}
                    />,
                    t(save.saved ? 'savedSuggestions.removeAction' : 'savedSuggestions.saveAction'),
                    save.onToggle,
                    save.saved,
                ) : null}
                {track ? renderButton(
                    <MaterialIcons
                        name="track-changes"
                        size={ICON_SIZE}
                        color={storyTracked ? SELECTED_ICON : PRIMARY}
                    />,
                    t(storyTracked ? 'trackedStories.untrackAction' : 'trackedStories.trackAction'),
                    onTrackPress,
                    storyTracked,
                ) : null}
                {share?.url ? renderButton(
                    <MaterialIcons
                        name={Platform.OS === 'ios' ? 'ios-share' : 'share'}
                        size={ICON_SIZE}
                        color={PRIMARY}
                    />,
                    t('articleDetail.share'),
                    handleSharePress,
                    false,
                ) : null}
            </HStack>
        </Box>
    );
};

export default ArticleFeedbackPrompt;
