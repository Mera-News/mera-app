import { buildContextJson, type FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import {
  getArticleVerdict,
  markFeedbackProcessedFor,
  recordVerdictFeedback,
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
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { hapticLight, hapticMedium, hapticSuccess } from '@/lib/haptics';
import { useShareArticle, type ShareArticleParams } from '@/lib/hooks/useShareArticle';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';
import { useSavedOverride } from '@/lib/saved-state';

/** A verdict's stored states: none → recorded without a reason → a leaf
 *  committed. Both recorded states DISPLAY the same (filled, see
 *  CardActionBar); the split only mirrors the stored `committed` flag. */
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
}

export interface ArticleActions {
  likeState: VerdictState;
  /** "Not for me", in the same three states. Never set while `likeState` is:
   *  the two are mutually exclusive (latest wins). */
  dislikeState: VerdictState;
  saved: boolean;
  /** Records the like (or removes it when already liked). The feedback tree
   *  is NOT opened here: the caller pushes it into the ••• sheet. */
  onLike: () => void;
  /** Records the dislike (or removes it when already disliked). The caller
   *  pushes the dislike tree. */
  onDislike: () => void;
  onAskMera: () => void;
  onToggleSave: () => void;
  /** Undefined when there is nothing to share. */
  onShare?: () => void;
  /** A tree leaf settled for `sentiment`: persist the path and, for a
   *  committed like, fill the thumb. */
  onLeafPicked: (sentiment: VerdictSentiment, pathIds: string[], appliedCount: number, committed: boolean) => void;
}

/**
 * The origin-aware inline actions (like, not for me, save, share, plus Ask
 * Mera and Follow for rows without a ••• menu), for a surface that does NOT
 * get its verdict from a host: the standalone card, the compact rows. Every
 * action is driven by a {@link FeedbackSubject}, so it works for suggestions
 * and standalone articles alike:
 *   - Like/Dislike → `recordVerdictFeedback` (latest wins: recording one
 *     removes the other, reverting what it applied) carrying origin + surface + a JSON
 *     context snapshot. The feedback tree for THAT verdict (D17) is pushed
 *     into the ••• sheet by the caller (useArticleMenu), never a second
 *     Modal. The thumb fills at once; Cancel keeps the verdict. A bare verdict
 *     never reaches the digest (D15).
 *   - Save → suggestions persist via `saveSuggestion`; standalone articles via
 *     `saveStandaloneArticle`. State restored on mount via `isSuggestionSaved`.
 *
 * Costs two local reads per mounted row (verdict, saved).
 */
export function useArticleActions({
  subject,
  suggestion,
  article,
  share,
}: UseArticleActionsInput): ArticleActions {
  const [likeState, setLikeState] = useState<VerdictState>('none');
  const [dislikeState, setDislikeState] = useState<VerdictState>('none');
  const liked = likeState !== 'none';
  const disliked = dislikeState !== 'none';
  const [savedFromDb, setSavedFromDb] = useState(false);
  const handleShare = useShareArticle(share);

  // The save/like restore keys off the same id used to persist them.
  const savedId = subject.suggestionId ?? subject.articleId;
  // See lib/saved-state — a save/delete performed on ANY other surface corrects
  // this row, instead of it holding a stale flag until remount.
  const savedOverride = useSavedOverride(savedId);
  const saved = savedOverride ?? savedFromDb;

  // Restore the verdict AND whether that like ever got a reason attached, so the
  // fill state survives a remount instead of silently downgrading.
  useEffect(() => {
    let cancelled = false;
    // An async IIFE (not `.then().catch()`) so the whole restore, lookup
    // included, is non-fatal: this is decoration, never a reason to take the
    // actions row down.
    void (async () => {
      const { verdict, committed } = await getArticleVerdict(subject.articleId);
      if (cancelled || !verdict) return;
      // F2/F3 — the stored PATH is not a commit signal (a branch descent writes
      // one). Only the persisted `committed` flag is.
      const state: VerdictState = committed ? 'committed' : 'provisional';
      if (verdict === 'like') setLikeState(state);
      else setDislikeState(state);
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

  // Records the verdict row. Shared by both thumbs; the tree is the caller's.
  // Latest wins: the writer removes the opposite row first. The non-exclusive
  // writer used here before let a like and a dislike coexist, and returned
  // early on an existing row, so "Not for me" on an already-disliked article
  // wrote nothing and said nothing.
  const recordVerdict = useCallback(
    (sentiment: VerdictSentiment) => {
      void recordVerdictFeedback({
        articleId: subject.articleId,
        suggestionId: subject.suggestionId,
        sentiment,
        title: subject.title,
        origin: subject.origin,
        surface: subject.surface,
        contextJson: buildContextJson(subject),
      });
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
    setDislikeState('none');
    recordVerdict('like');
  }, [liked, subject.articleId, recordVerdict]);

  const onDislike = useCallback(() => {
    if (disliked) {
      hapticLight();
      setDislikeState('none');
      void removeArticleFeedback(subject.articleId, 'dislike');
      return;
    }
    hapticMedium();
    setDislikeState('provisional');
    setLikeState('none');
    recordVerdict('dislike');
  }, [disliked, subject.articleId, recordVerdict]);

  // A terminal leaf settled. `committed` comes from the leaf rather than
  // being inferred from `appliedCount`: a seenOnly leaf changes nothing by
  // design and must leave the thumb unfilled, while a leaf whose placeholders
  // couldn't be resolved still counts as a reason the user gave.
  //
  // ORDER MATTERS: a committed path write re-opens the row for the digest
  // (processed_at = null), and it lands AFTER applyLeafActions stamped the row
  // spent. So when something applied, stamp it again after the write, or the
  // 3-hourly digest applies a second helping of the same signal.
  const onLeafPicked = useCallback(
    (sentiment: VerdictSentiment, pathIds: string[], appliedCount: number, committed: boolean) => {
      if (committed) (sentiment === 'like' ? setLikeState : setDislikeState)('committed');
      void (async () => {
        await updateFeedbackContextPath(subject.articleId, sentiment, pathIds, committed);
        if (appliedCount > 0) await markFeedbackProcessedFor(subject.articleId, sentiment);
      })();
    },
    [subject.articleId],
  );

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

  return {
    likeState,
    dislikeState,
    saved,
    onLike,
    onDislike,
    onAskMera,
    onToggleSave,
    onShare: share?.url ? handleSharePress : undefined,
    onLeafPicked,
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
