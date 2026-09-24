import CardActionBar from '@/components/custom/cards/CardActionBar';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { useArticleActions } from '@/components/custom/cards/use-article-actions';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
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
 * and Follow inline because this card has no ••• menu.
 *
 * Its thumbs and Follow open the SAME sheet the ••• menu uses (useArticleMenu),
 * straight at the feedback tree's root or the follow level, with no Back row:
 * the one look for every article sub-menu.
 */
export const ArticleActionsRow: React.FC<ArticleActionsRowProps> = ({
  subject,
  suggestion,
  article,
  share,
}) => {
  const actions = useArticleActions({ subject, suggestion, article, share });
  const sheet = useArticleMenu({
    surface: 'card',
    subject,
    // The sheet title shows the headline the card shows.
    titleOriginal: share?.titleOriginal,
    languageCode: share?.sourceLanguage,
    onLeafPicked: actions.onLeafPicked,
    // The inline crosshair shows the follow state all the time.
    followLive: true,
  });
  const onLike = () => {
    const wasLiked = actions.likeState !== 'none';
    actions.onLike();
    if (!wasLiked) sheet.openFeedback('like');
  };
  // A second tap on a filled thumb removes the verdict; only a new verdict
  // opens its tree.
  const onDislike = () => {
    const wasDisliked = actions.dislikeState !== 'none';
    actions.onDislike();
    if (!wasDisliked) sheet.openFeedback('dislike');
  };
  const verdict = actions.likeState !== 'none' ? 'like' : actions.dislikeState !== 'none' ? 'dislike' : null;
  return (
    <>
      {/* `horizontalPadding={0}`: this row renders as ArticleCardBase's
          CHILDREN, which already sit inside that card's `p-4`. */}
      <CardActionBar
        verdict={verdict}
        saved={actions.saved}
        onLike={onLike}
        onDislike={onDislike}
        onAskMera={actions.onAskMera}
        onToggleSave={actions.onToggleSave}
        onTrack={sheet.openFollow}
        tracked={sheet.tracked}
        onShare={actions.onShare}
        horizontalPadding={0}
      />
      {sheet.element}
    </>
  );
};

export default ArticleActionsRow;
