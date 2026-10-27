import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { getArticleVerdict } from '@/lib/database/services/article-feedback-service';
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
  /** The reader answered the feedback sheet for this article (a stored
   *  dislike verdict). A like stored before v6 never counts. */
  answered: boolean;
  saved: boolean;
  /** The sheet wrote the verdict (the reader's first answer). */
  onVerdictRecorded: () => void;
  onAskMera: () => void;
  onToggleSave: () => void;
  /** Undefined when there is nothing to share. */
  onShare?: () => void;
}

/**
 * The origin-aware inline actions (save, share, Ask Mera) and the answered
 * state, for a surface that does NOT get its verdict from a host: the
 * standalone card, the compact rows. The feedback sheet (useArticleMenu)
 * writes the verdict on the reader's first answer and reports it through
 * `onVerdictRecorded`. Save: suggestions persist via `saveSuggestion`,
 * standalone articles via `saveStandaloneArticle`.
 *
 * Costs two local reads per mounted row (verdict, saved).
 */
export function useArticleActions({
  subject,
  suggestion,
  article,
  share,
}: UseArticleActionsInput): ArticleActions {
  const [answered, setAnswered] = useState(false);
  const [savedFromDb, setSavedFromDb] = useState(false);
  const handleShare = useShareArticle(share);

  // The save/like restore keys off the same id used to persist them.
  const savedId = subject.suggestionId ?? subject.articleId;
  // See lib/saved-state — a save/delete performed on ANY other surface corrects
  // this row, instead of it holding a stale flag until remount.
  const savedOverride = useSavedOverride(savedId);
  const saved = savedOverride ?? savedFromDb;

  // Restore the answered state. Old likes (before v6) never light it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { verdict } = await getArticleVerdict(subject.articleId);
      if (!cancelled && verdict === 'dislike') setAnswered(true);
    })().catch(() => {
      /* non-fatal: decoration, never a reason to take the row down */
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

  const onVerdictRecorded = useCallback(() => setAnswered(true), []);

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
    answered,
    saved,
    onVerdictRecorded,
    onAskMera,
    onToggleSave,
    onShare: share?.url ? handleSharePress : undefined,
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
