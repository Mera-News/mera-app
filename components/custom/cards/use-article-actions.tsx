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
import type { TFunction } from 'i18next';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSavedOverride } from '@/lib/saved-state';

/** A thumb's three states: untouched → tapped-but-context-less → committed. */
export type VerdictState = 'none' | 'provisional' | 'committed';

export interface UseArticleActionsInput {
  /** Origin-aware descriptor of what's being acted on + where. */
  subject: FeedbackSubject;
  /** The source suggestion — required to persist a save on the 'suggestion'
   *  path (a full snapshot is stored). Ignored for 'article' origin. */
  suggestion?: ForYouSuggestion;
  /** The source article — required to persist a save on the 'article' path. */
  article?: NewsArticle;
  /** Share params (URL/title). No share handler when absent / no url. */
  share?: ShareArticleParams;
  /** Whether to read the follow state. False where Follow lives in the •••
   *  menu instead (the menu reads it itself, once opened). */
  trackActive?: boolean;
}

export interface ArticleActions {
  likeState: VerdictState;
  saved: boolean;
  tracked: boolean;
  onLike: () => void;
  onDislike: () => void;
  onAskMera: () => void;
  onToggleSave: () => void;
  onTrack: () => void;
  /** Undefined when there is nothing to share. */
  onShare?: () => void;
  /** Mount once: the feedback tree overlay and the follow dialogs. */
  element: React.ReactNode;
}

/**
 * The origin-aware inline actions (like, not for me, save, share, plus Ask
 * Mera and Follow for rows without a ••• menu), for a surface that does NOT
 * get its verdict from a host: the standalone card, the compact rows. Every
 * action is driven by a {@link FeedbackSubject}, so it works for suggestions
 * and standalone articles alike:
 *   - Like/Dislike → `recordArticleFeedback` carrying origin + surface + a JSON
 *     context snapshot, then opens the feedback tree for THAT verdict (D17: a
 *     thumbs-up used to open nothing, so the like tree's boost/weight leaves
 *     had never run). The thumb stays tinted-not-filled until a leaf is
 *     picked: filled means "this changed your persona" (D15).
 *   - Save → suggestions persist via `saveSuggestion`; standalone articles via
 *     `saveStandaloneArticle`. State restored on mount via `isSuggestionSaved`.
 *
 * Costs two local reads per mounted row (verdict, saved). The tree overlay is
 * a Modal that renders nothing until opened.
 */
export function useArticleActions({
  subject,
  suggestion,
  article,
  share,
  trackActive = true,
}: UseArticleActionsInput): ArticleActions {
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
  const { tracked, onPress: onTrackPress, dialog: trackDialog } = useTrackButton(subject, trackActive);

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
    // An async IIFE (not `.then().catch()`) so the whole restore, lookup
    // included, is non-fatal: this is decoration, never a reason to take the
    // actions row down.
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

  // Records the verdict row and opens the matching tree. Shared by both thumbs;
  // only the root differs.
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

  const onLike = useCallback(() => {
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

  const onDislike = useCallback(() => {
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

  const onToggleSave = useCallback(() => {
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

  const onAskMera = useCallback(() => {
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

  const element = (
    <>
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

  return {
    likeState,
    saved,
    tracked,
    onLike,
    onDislike,
    onAskMera,
    onToggleSave,
    onTrack: onTrackPress,
    onShare: share?.url ? handleSharePress : undefined,
    element,
  };
}

/** One inline action as a VoiceOver custom action. */
export interface InlineAccessibilityAction {
  key: string;
  label: string;
  run: () => void;
}

/**
 * The four inline actions (like, not for me, save, share) as VoiceOver custom
 * actions. A card's root Pressable is ONE accessibility element on iOS, which
 * hides the buttons drawn inside it, so without these a screen-reader user
 * could reach the ••• items but not the row's own buttons.
 */
export function inlineAccessibilityActions(
  t: TFunction,
  a: {
    saved: boolean;
    onLike: () => void;
    onDislike: () => void;
    onToggleSave?: () => void;
    onShare?: () => void;
  },
): InlineAccessibilityAction[] {
  const list: InlineAccessibilityAction[] = [
    { key: 'like', label: t('articleFeedback.likeLabel'), run: a.onLike },
    { key: 'dislike', label: t('articleFeedback.dislikeLabel'), run: a.onDislike },
  ];
  if (a.onToggleSave) {
    list.push({
      key: 'save',
      label: t(a.saved ? 'savedSuggestions.removeAction' : 'savedSuggestions.saveAction'),
      run: a.onToggleSave,
    });
  }
  if (a.onShare) list.push({ key: 'share', label: t('articleDetail.share'), run: a.onShare });
  return list;
}
