import CardActionBar from '@/components/custom/cards/CardActionBar';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { useArticleActions, type ArticleActions } from '@/components/custom/cards/use-article-actions';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { ShareArticleParams } from '@/lib/hooks/useShareArticle';
import React from 'react';

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
 * Universal, origin-aware actions row for the standalone card (Saved list):
 * the shared `CardActionBar` driven by {@link useArticleActions}, with Ask Mera
 * and Follow inline because this card has no ••• menu yet.
 *
 * Compact rows do NOT use this component: they call `useArticleActions`
 * themselves, because their card root also needs the handlers for its
 * VoiceOver custom actions.
 */
export const ArticleActionsRow: React.FC<ArticleActionsRowProps> = ({
  subject,
  suggestion,
  article,
  share,
}) => {
  const actions = useArticleActions({ subject, suggestion, article, share });
  return (
    <>
      {/* `horizontalPadding={0}`: this row renders as ArticleCardBase's
          CHILDREN, which already sit inside that card's `p-4`. */}
      <ArticleActionBarFor actions={actions} horizontalPadding={0} />
      {actions.element}
    </>
  );
};

/**
 * The `CardActionBar` for a set of {@link useArticleActions} handlers.
 *
 * Dislike maps to a null verdict, not to 'dislike': these actions have never
 * persisted or restored a dislike (only likes are read back on mount), so a
 * selected-looking thumb-down would be a state the row cannot actually hold.
 */
export const ArticleActionBarFor: React.FC<{
  actions: ArticleActions;
  horizontalPadding?: number;
  /** D3: when set, Ask Mera and Follow move into the ••• menu. */
  onOverflow?: () => void;
}> = ({ actions, horizontalPadding, onOverflow }) => (
  <CardActionBar
    verdict={actions.likeState !== 'none' ? 'like' : null}
    provisional={actions.likeState === 'provisional'}
    saved={actions.saved}
    onLike={actions.onLike}
    onDislike={actions.onDislike}
    onAskMera={actions.onAskMera}
    onToggleSave={actions.onToggleSave}
    onTrack={actions.onTrack}
    tracked={actions.tracked}
    onShare={actions.onShare}
    onOverflow={onOverflow}
    horizontalPadding={horizontalPadding}
  />
);

export default ArticleActionsRow;
