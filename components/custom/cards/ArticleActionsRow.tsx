import { HStack } from '@/components/ui/hstack';
import MeraLogo from '@/components/custom/MeraLogo';
import FeedbackTreeOverlay from '@/components/custom/feedback-tree/FeedbackTreeOverlay';
import { Pressable } from '@/components/ui/pressable';
import { buildContextJson, type FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import {
  getArticleVerdict,
  markFeedbackProcessedFor,
  recordArticleFeedback,
  removeArticleFeedback,
  updateFeedbackContextPath,
  type VerdictSentiment,
} from '@/lib/database/services/article-feedback-service';
import {
  saveSuggestion,
  saveStandaloneArticle,
  deleteSavedSuggestion,
  isSuggestionSaved,
} from '@/lib/database/services/saved-article-suggestion-service';
import { buildOverlayContext } from '@/components/custom/cards/overlay-context';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import { useTrackButton } from '@/components/custom/tracked-stories/use-track-button';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSavedOverride } from '@/lib/saved-state';
import { Platform } from 'react-native';

// Primary-orange accent — dark-locked, matches ArticleFeedbackPrompt exactly so
// the row is pixel-identical wherever the two coexist.
const PRIMARY = '#EDA77E';
const SELECTED_ICON = '#1a1a1a';
// D15 — the PROVISIONAL treatment: a verdict is recorded but carries no reason
// yet, so the button is tinted, not filled. Filled is a promise ("this changed
// your persona") and a bare tap has not earned it. Same translucent accent the
// feedback tree uses for a picked chip — no new token.
const PROVISIONAL_BG = 'rgba(237,167,126,0.18)';
const ICON_SIZE = 22;
const BUTTON_SIZE = 48;

/** A thumb's three states: untouched → tapped-but-context-less → committed. */
type VerdictState = 'none' | 'provisional' | 'committed';

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

/**
 * Universal, origin-aware actions row. Visually identical to
 * `ArticleFeedbackPrompt` (Mera chat / like / dislike / save / share), but every
 * action is driven by a {@link FeedbackSubject} so it works for both
 * personalized suggestions and standalone articles:
 *   - Like/Dislike → `recordArticleFeedback` carrying origin + surface + a JSON
 *     context snapshot, then opens the server-owned feedback tree for THAT
 *     verdict (D17 — a thumbs-up used to open nothing, so the like tree's
 *     boost/weight leaves had never run). The thumb stays tinted-not-filled
 *     until a leaf is picked: filled means "this changed your persona" (D15).
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
  const [likeState, setLikeState] = useState<VerdictState>('none');
  const liked = likeState !== 'none';
  const [savedFromDb, setSavedFromDb] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  // Which tree the overlay is showing — D17 gave the thumbs-UP one too.
  const [overlayRoot, setOverlayRoot] = useState<VerdictSentiment>('dislike');
  const [overlayCtx, setOverlayCtx] = useState<LocalFeedbackContext>({
    articleTitle: subject.title,
  });
  const handleShare = useShareArticle(share);
  const { tracked, onPress: onTrackPress, dialog: trackDialog } = useTrackButton(subject);

  // The save/like restore keys off the same id used to persist them.
  const savedId = subject.suggestionId ?? subject.articleId;
  // See lib/saved-state — a save/delete performed on ANY other surface corrects
  // this row, instead of it holding a stale flag until remount.
  const savedOverride = useSavedOverride(savedId);
  const saved = savedOverride ?? savedFromDb;

  // Restore "liked" AND whether that like ever got a reason attached, so the
  // fill state survives a remount instead of silently downgrading.
  useEffect(() => {
    let cancelled = false;
    // Wrapped in an async IIFE (not `.then().catch()`) so the whole restore —
    // lookup included — is non-fatal: this is decoration, never a reason to
    // take the actions row down.
    void (async () => {
      const { verdict, committed } = await getArticleVerdict(subject.articleId);
      if (cancelled || verdict !== 'like') return;
      // F2/F3 — the stored PATH is not a commit signal (a branch descent writes
      // one). Only the persisted `committed` flag is.
      setLikeState(committed ? 'committed' : 'provisional');
    })().catch(() => {
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
        if (!cancelled) setSavedFromDb(v);
      })
      .catch(() => {
        /* non-fatal */
      });
    return () => {
      cancelled = true;
    };
  }, [savedId]);

  // Records the verdict row and opens the matching tree. Shared by both thumbs:
  // a thumbs-UP used to open nothing at all, so the like tree's boost/weight
  // leaves could never run (D17). Presentation is the same overlay; only the
  // root differs.
  const recordAndOpenTree = useCallback(
    (sentiment: VerdictSentiment) => {
      void recordArticleFeedback({
        articleId: subject.articleId,
        suggestionId: subject.suggestionId,
        sentiment,
        title: subject.title,
        origin: subject.origin,
        surface: subject.surface,
        contextJson: buildContextJson(subject),
      });
      void (async () => {
        const ctx = await buildOverlayContext(subject);
        setOverlayCtx(ctx);
        setOverlayRoot(sentiment);
        setOverlayOpen(true);
      })();
    },
    [subject],
  );

  const handleLike = useCallback(() => {
    if (liked) {
      hapticLight();
      setLikeState('none');
      void removeArticleFeedback(subject.articleId, 'like');
      return;
    }
    hapticSuccess();
    setLikeState('provisional');
    recordAndOpenTree('like');
  }, [liked, subject.articleId, recordAndOpenTree]);

  const handleDislike = useCallback(() => {
    hapticMedium();
    recordAndOpenTree('dislike');
  }, [recordAndOpenTree]);

  // A terminal leaf settled — persist the tapped path onto the verdict row
  // (that is what promotes the thumb from provisional to committed), and stamp
  // the row processed when the leaf actually applied something, so the 3-hourly
  // digest can't apply a second helping of the same signal.
  const handleLeafPicked = useCallback(
    (pathIds: string[], appliedCount: number) => {
      const sentiment = overlayRoot;
      if (sentiment === 'like') setLikeState('committed');
      void (async () => {
        await updateFeedbackContextPath(subject.articleId, sentiment, pathIds, true);
        if (appliedCount > 0) await markFeedbackProcessedFor(subject.articleId, sentiment);
      })();
    },
    [overlayRoot, subject.articleId],
  );

  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  const handleSave = useCallback(() => {
    if (saved) {
      hapticLight();
      void deleteSavedSuggestion(savedId);
      return;
    }
    hapticSuccess();
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
    testID: string,
    provisional = false,
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
        backgroundColor: selected ? PRIMARY : provisional ? PROVISIONAL_BG : 'transparent',
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
        {/* Mera stays in THIS row. Its only consumer is ArticleStandaloneCard —
            a standalone article has no relevance rationale, so there is no
            "Mera's voice" block for the glyph to move onto (unlike the
            suggestion card / suggestion detail screen, where it did move).
            Removing it here would delete the affordance outright. */}
        <Pressable
          testID="card-action-mera"
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
            color={likeState === 'committed' ? SELECTED_ICON : PRIMARY}
          />,
          t('articleFeedback.likeLabel'),
          handleLike,
          likeState === 'committed',
          'card-action-like',
          likeState === 'provisional',
        )}
        {renderButton(
          <MaterialIcons name="thumb-down" size={ICON_SIZE} color={PRIMARY} />,
          t('articleFeedback.dislikeLabel'),
          handleDislike,
          false,
          'card-action-dislike',
        )}
        {renderButton(
          <MaterialIcons
            name={saved ? 'bookmark' : 'bookmark-border'}
            size={ICON_SIZE}
            color={saved ? SELECTED_ICON : PRIMARY}
          />,
          t(saved ? 'savedSuggestions.removeAction' : 'savedSuggestions.saveAction'),
          handleSave,
          saved,
          'card-action-save',
        )}
        {renderButton(
          <MaterialIcons
            name="track-changes"
            size={ICON_SIZE}
            color={tracked ? SELECTED_ICON : PRIMARY}
          />,
          t(tracked ? 'trackedStories.untrackAction' : 'trackedStories.trackAction'),
          onTrackPress,
          tracked,
          'card-action-track',
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
          'card-action-share',
        ) : null}
      </HStack>
      {trackDialog}
      <FeedbackTreeOverlay
        visible={overlayOpen}
        onClose={closeOverlay}
        root={overlayRoot}
        onLeafPicked={handleLeafPicked}
        context={overlayCtx}
        chatContext={{
          kind: 'article-suggestion',
          articleId: subject.articleId,
          suggestionId: subject.suggestionId,
          articleTitle: subject.title,
        }}
        chatMessage={t(
          overlayRoot === 'like'
            ? 'articleFeedback.thumbsUpMessage'
            : 'articleFeedback.thumbsDownMessage',
          { title: subject.title },
        )}
      />
    </>
  );
};

export default ArticleActionsRow;
