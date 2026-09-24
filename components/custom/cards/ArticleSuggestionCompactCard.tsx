import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import { ArticleActionBarFor } from '@/components/custom/cards/ArticleActionsRow';
import { visitFromSuggestion } from '@/components/custom/cards/article-actions';
import {
  feedbackSubjectFromSuggestion,
  type FeedbackSurface,
} from '@/components/custom/cards/feedback-subject';
import { inlineAccessibilityActions, useArticleActions } from '@/components/custom/cards/use-article-actions';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
import RelevanceChip from '@/components/custom/RelevanceChip';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface ArticleSuggestionCompactCardProps {
  suggestion: ForYouSuggestion;
  onPress: (suggestion: ForYouSuggestion) => void;
  surface?: FeedbackSurface;
  /** Dims the row (~0.55 opacity) — e.g. already-opened Earlier-zone rows. */
  dimmed?: boolean;
  /** Marks the row as already-read. Draws NO indicator of its own — there is no
   *  green tick chip and no eye glyph; both were deliberately removed. It only
   *  suppresses the NEW badge in the meta row, since a story you have read is
   *  not new to you. Forwarded verbatim to `ArticleCompactCardBase`, whose doc
   *  is the source of truth. The Dashboard surfaces use this. */
  read?: boolean;
  /** Renders the green "NEW" pill in the meta row (Dashboard section cards). */
  isNew?: boolean;
}

/**
 * The compact suggestion variant, a personalized row for dense lists (the
 * Dashboard sections). `priorityAccessory` is the compact RelevanceChip (once
 * relevance is ready). Under the body sits the compact action row (D3): like,
 * not for me, save, share, then ••• for everything else; long-press opens the
 * same menu.
 *
 * Tapping the row navigates (`onPress`) to a detail screen; the row itself
 * opens the publisher only from the ••• menu, where the translate route sits
 * beside it.
 */
const ArticleSuggestionCompactCardImpl: React.FC<ArticleSuggestionCompactCardProps> = ({
  suggestion,
  onPress,
  surface = 'triage',
  dimmed = false,
  read = false,
  isNew = false,
}) => {
  const { t } = useTranslation();
  const status = suggestion.status;
  const relevanceReady = !!status && status !== ArticleSuggestionStatus.Unscored;
  const relevance = suggestion.relevance ?? 0;

  // Compact cards never show reason text — the fixed-size RelevanceChip (once
  // relevance is ready) is the whole signal, and it rides in the middle of the
  // meta row. It sat in the footer until the image grew into that corner.
  const priorityAccessory = relevanceReady ? (
    <RelevanceChip relevance={relevance} />
  ) : undefined;

  const subject = useMemo(() => feedbackSubjectFromSuggestion(suggestion, surface), [suggestion, surface]);
  const share = useMemo(
    () => ({
      url: suggestion.article_url,
      titleEnglish: suggestion.title_en,
      titleOriginal: suggestion.title_original,
      sourceLanguage: suggestion.language_code,
    }),
    [suggestion],
  );
  const visit = useMemo(() => visitFromSuggestion(suggestion), [suggestion]);

  const actions = useArticleActions({ subject, suggestion, share, trackActive: false });
  const inlineActions = useMemo(
    () => inlineAccessibilityActions(t, actions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, actions.saved, actions.onLike, actions.onDislike, actions.onToggleSave, actions.onShare],
  );
  const menu = useArticleMenu({
    surface: 'card',
    subject,
    articleUrl: suggestion.article_url,
    languageCode: suggestion.language_code,
    visit,
    // Answered on the detail screen, so the row opens it after asking.
    onCheckFacts: () => {
      // Required at call time: the fact-check client pulls in Apollo.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { requestArticleFactCheck } = require('@/lib/fact-check/request-article-fact-check') as typeof import('@/lib/fact-check/request-article-fact-check');
      const asked = requestArticleFactCheck({
        articleId: suggestion.articleId,
        title: suggestion.title_en ?? suggestion.title_original ?? '',
        suggestion,
      });
      if (asked) onPress(suggestion);
      return asked;
    },
    inlineActions,
  });

  return (
    <>
      <ArticleCompactCardBase
        testID={`card-${suggestion._id}`}
        imageUrl={suggestion.image_url}
        titleEnglish={suggestion.title_en}
        titleOriginal={suggestion.title_original ?? undefined}
        sourceLanguage={suggestion.language_code ?? undefined}
        pubDate={suggestion.firstPubDate ?? suggestion.createdAt}
        languageCode={suggestion.language_code}
        countryCode={suggestion.country_code}
        publicationName={suggestion.publication_name}
        recyclingKey={suggestion._id}
        dimmed={dimmed}
        read={read}
        isNew={isNew}
        onPress={() => onPress(suggestion)}
        onLongPress={menu.open}
        priorityAccessory={priorityAccessory}
        footer={<ArticleActionBarFor actions={actions} onOverflow={menu.open} horizontalPadding={0} compact />}
        accessibilityActions={menu.accessibilityActions}
        onAccessibilityAction={menu.onAccessibilityAction}
      />
      {actions.element}
      {menu.element}
    </>
  );
};

export const ArticleSuggestionCompactCard = React.memo(ArticleSuggestionCompactCardImpl);

export default ArticleSuggestionCompactCard;
