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
import { openFeedbackChatWithPath } from '@/lib/services/swipe-feedback';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import { useTrackedSubject } from '@/lib/tracking/use-tracked-subject';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import type { Verdict } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
    /** Optional on-device context that seeds the feedback surface's tree gating. */
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
 *     open, no auto-sent message).
 *   - Like / Dislike → records the verdict (latest-wins, mutually exclusive) and
 *     FLOATS the inline feedback surface over the content above the row so the
 *     user can optionally pick a reason. Re-tapping the same thumb removes the
 *     verdict + its feedback; the surface's × just hides it (keeps the verdict).
 *     No persona mutation happens here — feedback stays deferred, matching the
 *     For You feed.
 *   - Save (optional) → toggles the saved-for-later state (caller-owned).
 *   - Track (optional) → toggles story tracking.
 *   - Share (optional, only when the `share` prop has a URL).
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
    const [verdict, setVerdict] = useState<Verdict | null>(null);
    const [initialPath, setInitialPath] = useState<string[]>([]);
    const [surfaceClosed, setSurfaceClosed] = useState(false);
    // Self-managing track state. `track` carries the stable id when known; the
    // fallback subject keeps the hook happy when the button is absent.
    const trackSubject: FeedbackSubject =
        track ?? { origin: 'article', surface: 'detail', articleId, title };
    const { tracked: storyTracked, toggle: toggleTrack } = useTrackedSubject(
        trackSubject,
        !!track,
    );
    const handleShare = useShareArticle(share);

    // Restore the stored verdict + tree path across remounts (leaving/reopening).
    useEffect(() => {
        let cancelled = false;
        getArticleVerdict(articleId)
            .then(({ verdict: v, path }) => {
                if (cancelled) return;
                setVerdict(v);
                setInitialPath(path);
            })
            .catch(() => {
                /* non-fatal — default to no verdict */
            });
        return () => {
            cancelled = true;
        };
    }, [articleId]);

    // The origin-aware subject used to snapshot context onto the verdict row.
    const subject: FeedbackSubject = useMemo(
        () => ({
            origin: suggestionId ? 'suggestion' : 'article',
            surface: 'detail',
            articleId,
            suggestionId,
            title,
            publicationName: feedbackContext?.publicationName,
            countryCode: feedbackContext?.countryCode,
            matchedTopics: feedbackContext?.matchedTopics,
        }),
        [articleId, suggestionId, title, feedbackContext],
    );

    // A minimal ForYouSuggestion projection so the shared feedback surface (typed
    // to a suggestion) works on the detail page too. InlineFeedbackTree only reads
    // these fields — the rest are unused here.
    const surfaceSuggestion = useMemo(
        () =>
            ({
                _id: suggestionId ?? articleId,
                articleId,
                title_en: title,
                publication_name: feedbackContext?.publicationName ?? null,
                country_code: feedbackContext?.countryCode ?? null,
                matchedTopics: feedbackContext?.matchedTopics ?? [],
            }) as unknown as ForYouSuggestion,
        [suggestionId, articleId, title, feedbackContext],
    );

    // Record / flip / un-vote — mirrors the feed's onVerdict.
    const onVerdict = useCallback(
        (next: Verdict) => {
            if (verdict === next) {
                hapticLight();
                setVerdict(null);
                setInitialPath([]);
                setSurfaceClosed(false);
                void removeArticleFeedback(articleId, next);
                return;
            }
            hapticSuccess();
            setVerdict(next);
            setInitialPath([]);
            setSurfaceClosed(false);
            void recordVerdictFeedback({
                articleId,
                suggestionId,
                sentiment: next,
                title,
                origin: subject.origin,
                surface: subject.surface,
                contextJson: buildContextJson(subject),
            });
        },
        [verdict, articleId, suggestionId, title, subject],
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
    // A terminal leaf (the last input in the tree) — persist, then close.
    const handleLeafCommitted = useCallback(
        (_s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
            setInitialPath(pathIds);
            void updateFeedbackContextPath(articleId, v, pathIds);
            setSurfaceClosed(true);
        },
        [articleId],
    );
    const handleInvokeMera = useCallback(
        (s: ForYouSuggestion, v: Verdict, pathIds: string[]) => {
            void openFeedbackChatWithPath(s, v, pathIds);
            // Escalating to the chat is terminal — close the surface.
            setSurfaceClosed(true);
        },
        [],
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

    const surfaceVisible = verdict != null && !surfaceClosed;

    // A single action button. `selected` fills it (filled/orange treatment).
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
        <Box className="relative">
            {/* Floating feedback surface — anchored just above the action row
                (bottom: 100%), so it floats over the content above it. */}
            {surfaceVisible && verdict ? (
                <Box className="absolute left-0 right-0" style={{ bottom: '100%', marginBottom: 8 }}>
                    <CardFeedbackSurface
                        fill={false}
                        suggestion={surfaceSuggestion}
                        verdict={verdict}
                        initialPathIds={initialPath}
                        onClose={handleCloseSurface}
                        onTreePathChanged={handleTreePathChanged}
                        onInvokeMera={handleInvokeMera}
                        onLeafCommitted={handleLeafCommitted}
                    />
                </Box>
            ) : null}

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
                        color={verdict === 'like' ? SELECTED_ICON : PRIMARY}
                    />,
                    t('articleFeedback.likeLabel'),
                    handleLike,
                    verdict === 'like',
                )}
                {renderButton(
                    <MaterialIcons
                        name="thumb-down"
                        size={ICON_SIZE}
                        color={verdict === 'dislike' ? SELECTED_ICON : PRIMARY}
                    />,
                    t('articleFeedback.dislikeLabel'),
                    handleDislike,
                    verdict === 'dislike',
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
        </Box>
    );
};

export default ArticleFeedbackPrompt;
