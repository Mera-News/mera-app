import CardActionBar from '@/components/custom/cards/CardActionBar';
import FeedbackTreeOverlay from '@/components/custom/feedback-tree/FeedbackTreeOverlay';
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
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSavedOverride } from '@/lib/saved-state';

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
 * Universal, origin-aware actions row. Renders the shared `CardActionBar` — the
 * same row the feed cards and the detail screens use (Mera chat / like /
 * dislike / save / track / share) — but every action is driven by a
 * {@link FeedbackSubject} so it works for both personalized suggestions and
 * standalone articles:
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

  // A terminal leaf settled. `committed` comes from the overlay rather than
  // being inferred from `appliedCount`: a seenOnly leaf changes nothing by
  // design and must leave the thumb unfilled, while a leaf whose placeholders
  // couldn't be resolved still counts as a reason the user gave. Stamps the row
  // processed when something actually applied, so the 3-hourly digest can't
  // apply a second helping of the same signal.
  const handleLeafPicked = useCallback(
    (pathIds: string[], appliedCount: number, committed: boolean) => {
      const sentiment = overlayRoot;
      if (sentiment === 'like' && committed) setLikeState('committed');
      void (async () => {
        await updateFeedbackContextPath(subject.articleId, sentiment, pathIds, committed);
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

  return (
    <>
      {/* The Mera glyph stays in this row (CardActionBar renders it
          unconditionally). Its only consumer is ArticleStandaloneCard — a
          standalone article has no relevance rationale, so there is no "Mera's
          voice" block for the glyph to move onto, unlike the suggestion card.

          `horizontalPadding={0}`: this row renders as ArticleCardBase's
          CHILDREN, which already sit inside that card's `p-4`.

          Dislike maps to a null verdict, not to 'dislike': this row has never
          persisted or restored a dislike (only likes are read back on mount),
          so a selected-looking thumb-down would be a state the component cannot
          actually hold. */}
      <CardActionBar
        verdict={likeState !== 'none' ? 'like' : null}
        provisional={likeState === 'provisional'}
        saved={saved}
        onLike={handleLike}
        onDislike={handleDislike}
        onAskMera={handleChatPress}
        onToggleSave={handleSave}
        onTrack={onTrackPress}
        tracked={tracked}
        onShare={share?.url ? handleSharePress : undefined}
        horizontalPadding={0}
      />
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
