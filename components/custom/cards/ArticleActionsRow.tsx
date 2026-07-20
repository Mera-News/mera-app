import { HStack } from '@/components/ui/hstack';
import MeraLogo from '@/components/custom/MeraLogo';
import FeedbackTreeOverlay from '@/components/custom/feedback-tree/FeedbackTreeOverlay';
import { Pressable } from '@/components/ui/pressable';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import {
  hasLiked,
  recordArticleFeedback,
  removeArticleFeedback,
} from '@/lib/database/services/article-feedback-service';
import {
  saveSuggestion,
  saveStandaloneArticle,
  deleteSavedSuggestion,
  isSuggestionSaved,
} from '@/lib/database/services/saved-article-suggestion-service';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import logger from '@/lib/logger';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

// Primary-orange accent — dark-locked, matches ArticleFeedbackPrompt exactly so
// the row is pixel-identical wherever the two coexist.
const PRIMARY = '#EDA77E';
const SELECTED_ICON = '#1a1a1a';
const ICON_SIZE = 19;
const BUTTON_SIZE = 45;

interface ArticleActionsRowProps {
  /** Origin-aware descriptor of what's being acted on + where. */
  subject: FeedbackSubject;
  /** The source suggestion — required to persist a save on the 'suggestion' path
   *  (a full snapshot is stored). Ignored for 'article' origin. */
  suggestion?: ForYouSuggestion;
  /** The source article — required to persist a save on the 'article' path. */
  article?: NewsArticle;
  /** Share params (URL/title). Share button hidden when absent / no url. */
  share?: ShareArticleParams;
}

/** Snapshot the subject's contextual extras for the persisted feedback row. */
function buildContextJson(subject: FeedbackSubject): string | null {
  const snapshot: Record<string, unknown> = {};
  if (subject.scopeKey) snapshot.scopeKey = subject.scopeKey;
  if (subject.stableClusterId) snapshot.stableClusterId = subject.stableClusterId;
  if (subject.eventType) snapshot.eventType = subject.eventType;
  if (typeof subject.relevance === 'number') snapshot.relevance = subject.relevance;
  if (subject.matchedTopics && subject.matchedTopics.length > 0) {
    snapshot.matchedTopics = subject.matchedTopics;
  }
  return Object.keys(snapshot).length > 0 ? JSON.stringify(snapshot) : null;
}

/**
 * Universal, origin-aware actions row. Visually identical to
 * `ArticleFeedbackPrompt` (Mera chat / like / dislike / save / share), but every
 * action is driven by a {@link FeedbackSubject} so it works for both
 * personalized suggestions and standalone articles:
 *   - Like/Dislike → `recordArticleFeedback` carrying origin + surface + a JSON
 *     context snapshot. Dislike also opens the server-owned feedback tree.
 *   - Save → suggestions persist via `saveSuggestion`; standalone articles via
 *     `saveStandaloneArticle`. State restored on mount via `isSuggestionSaved`.
 *   - Share → native share sheet (unchanged).
 */
export const ArticleActionsRow: React.FC<ArticleActionsRowProps> = ({
  subject,
  suggestion,
  article,
  share,
}) => {
  const { t } = useTranslation();
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [overlayCtx, setOverlayCtx] = useState<LocalFeedbackContext>({
    articleTitle: subject.title,
  });
  const handleShare = useShareArticle(share);

  // The save/like restore keys off the same id used to persist them.
  const savedId = subject.suggestionId ?? subject.articleId;

  // Restore "liked" across remounts.
  useEffect(() => {
    let cancelled = false;
    hasLiked(subject.articleId)
      .then((v) => {
        if (!cancelled && v) setLiked(true);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [subject.articleId]);

  // Restore "saved" across remounts.
  useEffect(() => {
    let cancelled = false;
    isSuggestionSaved(savedId)
      .then((v) => {
        if (!cancelled && v) setSaved(true);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [savedId]);

  const handleLike = useCallback(() => {
    if (liked) {
      hapticLight();
      setLiked(false);
      void removeArticleFeedback(subject.articleId, 'like');
      return;
    }
    hapticSuccess();
    setLiked(true);
    void recordArticleFeedback({
      articleId: subject.articleId,
      suggestionId: subject.suggestionId,
      sentiment: 'like',
      title: subject.title,
      origin: subject.origin,
      surface: subject.surface,
      contextJson: buildContextJson(subject),
    });
  }, [liked, subject]);

  // Dislike records a 'dislike' feedback row (origin/surface) AND opens the
  // branching feedback-tree overlay (snapshotting the local context with the
  // live publication-visit count folded in).
  const handleDislike = useCallback(() => {
    hapticMedium();
    void recordArticleFeedback({
      articleId: subject.articleId,
      suggestionId: subject.suggestionId,
      sentiment: 'dislike',
      title: subject.title,
      origin: subject.origin,
      surface: subject.surface,
      contextJson: buildContextJson(subject),
    });
    void (async () => {
      let publicationVisits = 0;
      const pub = subject.publicationName?.trim();
      if (pub) {
        try {
          publicationVisits = await getVisitCountForPublication(
            pub,
            subject.countryCode ?? null,
          );
        } catch (err) {
          logger.captureException(err, {
            tags: { component: 'ArticleActionsRow', method: 'visitCount' },
          });
        }
      }
      setOverlayCtx({
        publicationName: subject.publicationName,
        countryCode: subject.countryCode,
        // Empty for standalone articles — the overlay simply gates out the
        // topic-dependent nodes (evaluateCondition / resolveLeafActions tolerate it).
        matchedTopics: subject.matchedTopics ?? [],
        articleTitle: subject.title,
        publicationVisits,
      });
      setOverlayOpen(true);
    })();
  }, [subject]);

  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  const handleSave = useCallback(() => {
    if (saved) {
      hapticLight();
      setSaved(false);
      void deleteSavedSuggestion(savedId);
      return;
    }
    hapticSuccess();
    setSaved(true);
    if (subject.origin === 'article' && article) {
      void saveStandaloneArticle(article, { surface: subject.surface });
    } else if (suggestion) {
      void saveSuggestion(suggestion);
    }
  }, [saved, savedId, subject.origin, subject.surface, article, suggestion]);

  const handleChatPress = useCallback(() => {
    hapticMedium();
    useFloatingChatStore.getState().expand({
      kind: 'article-suggestion',
      articleId: subject.articleId,
      suggestionId: subject.suggestionId,
      articleTitle: subject.title,
    });
  }, [subject.articleId, subject.suggestionId, subject.title]);

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
        {renderButton(
          <MaterialIcons
            name={saved ? 'bookmark' : 'bookmark-border'}
            size={ICON_SIZE}
            color={saved ? SELECTED_ICON : PRIMARY}
          />,
          t('savedSuggestions.savedToastTitle'),
          handleSave,
          saved,
        )}
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
        chatContext={{
          kind: 'article-suggestion',
          articleId: subject.articleId,
          suggestionId: subject.suggestionId,
          articleTitle: subject.title,
        }}
        chatMessage={t('articleFeedback.thumbsDownMessage', { title: subject.title })}
      />
    </>
  );
};

export default ArticleActionsRow;
