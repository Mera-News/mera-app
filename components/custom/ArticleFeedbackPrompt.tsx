// NOTE(app-rethink wave): still LIVE on the article/suggestion detail screens.
// New card/feed code should use components/custom/cards/ArticleActionsRow (the
// origin-aware universal actions row) instead of this widget.
import { HStack } from '@/components/ui/hstack';
import MeraLogo from '@/components/custom/MeraLogo';
import FeedbackTreeOverlay from '@/components/custom/feedback-tree/FeedbackTreeOverlay';
import { Pressable } from '@/components/ui/pressable';
import {
    hasLiked,
    recordArticleFeedback,
    removeArticleFeedback,
} from '@/lib/database/services/article-feedback-service';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import { useTrackedSubject } from '@/lib/tracking/use-tracked-subject';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import logger from '@/lib/logger';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

/** Local-context fields a caller can supply so the feedback tree can gate nodes
 *  and resolve leaf placeholders (publication mute, topic downweight, geo, etc).
 *  All optional — missing fields simply hide the nodes that need them. */
export type ArticleFeedbackContext = Pick<
    LocalFeedbackContext,
    'publicationName' | 'countryCode' | 'matchedTopics' | 'clusterSize' | 'hasGeoMismatch' | 'geoText'
>;

interface ArticleFeedbackPromptProps {
    articleId: string;
    suggestionId?: string;
    title: string;
    /** Optional on-device context for the dislike → feedback-tree overlay. */
    feedbackContext?: ArticleFeedbackContext;
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

const ICON_SIZE = 19;
const BUTTON_SIZE = 45;

/**
 * Prominent feedback widget rendered directly under the reason box on the
 * article detail screens. Single row of round, primary-orange-outlined
 * buttons spread evenly across the width:
 *   - Chat with Mera → opens the floating Mera chat for this article (plain
 *     open, no auto-sent message) — replaces the old floating chat bubble. Bare
 *     logo button, no label — matches the old floating chat bubble treatment.
 *   - Like → tracked locally only (no chat); persists a `like` row and shows a
 *     filled selected treatment, restored on remount via `hasLiked`. Toggleable —
 *     re-tapping an already-liked button un-likes it, removing the row and
 *     clearing the filled treatment.
 *   - Dislike → opens the floating Mera chat with an article-feedback
 *     conversation and auto-sends an initial message.
 *   - Save (optional, only rendered when the `save` prop is provided) →
 *     toggles the saved-for-later state (persistence/toast handled by the
 *     caller); filled selected treatment while saved.
 *   - Share (optional, only rendered when the `share` prop has a URL) →
 *     shares the article via the native share sheet (see `useShareArticle`).
 * All labelled buttons set an accessibilityLabel.
 */
export const ArticleFeedbackPrompt: React.FC<ArticleFeedbackPromptProps> = ({
    articleId,
    suggestionId,
    title,
    feedbackContext,
    save,
    track,
    share,
}) => {
    const { t } = useTranslation();
    const [liked, setLiked] = useState(false);
    // Self-managing track state. `track` carries the stable id when known; the
    // fallback subject keeps the hook happy when the button is absent.
    const trackSubject: FeedbackSubject =
        track ?? { origin: 'article', surface: 'detail', articleId, title };
    const { tracked: storyTracked, toggle: toggleTrack } = useTrackedSubject(
        trackSubject,
        !!track,
    );
    // Dislike → server-owned feedback-tree overlay. Context is snapshotted at
    // press time (with the live publication-visit count folded in) so the tree
    // can gate nodes + resolve leaf-action placeholders.
    const [overlayOpen, setOverlayOpen] = useState(false);
    const [overlayCtx, setOverlayCtx] = useState<LocalFeedbackContext>({ articleTitle: title });
    const handleShare = useShareArticle(share);

    // Restore the "liked" acknowledgment across remounts (e.g. leaving and
    // reopening the article).
    useEffect(() => {
        let cancelled = false;
        hasLiked(articleId)
            .then((v) => {
                if (!cancelled && v) setLiked(true);
            })
            .catch(() => {
                /* non-fatal — default to not-liked */
            });
        return () => {
            cancelled = true;
        };
    }, [articleId]);

    const handleLike = useCallback(() => {
        if (liked) {
            hapticLight();
            setLiked(false);
            void removeArticleFeedback(articleId, 'like');
            return;
        }
        hapticSuccess();
        setLiked(true);
        void recordArticleFeedback({
            articleId,
            suggestionId,
            sentiment: 'like',
            title,
        });
    }, [liked, articleId, suggestionId, title]);

    // Dislike opens the branching feedback-tree overlay (fast-path
    // "not important" + "tell me more" descends the tree). Snapshot the local
    // context and enrich it with the live publication-visit count first.
    const handleDislike = useCallback(() => {
        hapticMedium();
        void (async () => {
            let publicationVisits = 0;
            const pub = feedbackContext?.publicationName?.trim();
            if (pub) {
                try {
                    publicationVisits = await getVisitCountForPublication(
                        pub,
                        feedbackContext?.countryCode ?? null,
                    );
                } catch (err) {
                    logger.captureException(err, {
                        tags: { component: 'ArticleFeedbackPrompt', method: 'visitCount' },
                    });
                }
            }
            setOverlayCtx({ ...feedbackContext, articleTitle: title, publicationVisits });
            setOverlayOpen(true);
        })();
    }, [feedbackContext, title]);

    const closeOverlay = useCallback(() => setOverlayOpen(false), []);

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

    const renderButton = (
        icon: React.ReactNode,
        label: string,
        onPress: () => void,
        selected: boolean,
    ) => (
        <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            className="items-center justify-center rounded-full"
            style={{
                width: BUTTON_SIZE,
                height: BUTTON_SIZE,
                backgroundColor: selected ? PRIMARY : 'transparent',
                borderWidth: 1.75,
                borderColor: PRIMARY,
            }}
        >
            {icon}
        </Pressable>
    );

    return (
        <>
        <HStack className="items-center justify-evenly px-1 py-3">
            <Pressable
                onPress={handleChatPress}
                accessibilityRole="button"
                accessibilityLabel="Mera"
                className="items-center justify-center rounded-full"
                style={{
                    width: BUTTON_SIZE,
                    height: BUTTON_SIZE,
                    backgroundColor: 'transparent',
                    borderWidth: 1.75,
                    borderColor: PRIMARY,
                }}
            >
                <MeraLogo size={28} />
            </Pressable>
            {renderButton(
                <MaterialIcons
                    name="thumb-up"
                    size={ICON_SIZE}
                    color={liked ? SELECTED_ICON : PRIMARY}
                />,
                t('articleFeedback.likeLabel'),
                handleLike,
                liked,
            )}
            {renderButton(
                <MaterialIcons name="thumb-down" size={ICON_SIZE} color={PRIMARY} />,
                t('articleFeedback.dislikeLabel'),
                handleDislike,
                false,
            )}
            {save ? renderButton(
                <MaterialIcons
                    name={save.saved ? 'bookmark' : 'bookmark-border'}
                    size={ICON_SIZE}
                    color={save.saved ? SELECTED_ICON : PRIMARY}
                />,
                t('savedSuggestions.savedToastTitle'),
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
                toggleTrack,
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
        <FeedbackTreeOverlay
            visible={overlayOpen}
            onClose={closeOverlay}
            context={overlayCtx}
            chatContext={{ kind: 'article-suggestion', articleId, suggestionId, articleTitle: title }}
            chatMessage={t('articleFeedback.thumbsDownMessage', { title })}
        />
        </>
    );
};

export default ArticleFeedbackPrompt;
