import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import { ArticleActionBarFor } from '@/components/custom/cards/ArticleActionsRow';
import type { ArticleMenuItem } from '@/components/custom/cards/ArticleOverflowMenu';
import { visitFromArticle } from '@/components/custom/cards/article-actions';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { inlineAccessibilityActions, useArticleActions } from '@/components/custom/cards/use-article-actions';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { extractDomain } from '@/lib/publisher-utils';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface ArticleStandaloneCompactCardProps {
  article: NewsArticle;
  onPress: () => void;
  /** Origin-aware overrides (surface, scopeKey, …) merged into the row's
   *  feedback subject, so a verdict carries where it was given. */
  subjectExtras?: Partial<FeedbackSubject>;
  /** Replaces the default long-press (which opens the ••• menu). A surface
   *  that already had a long-press action keeps it; it should ALSO offer that
   *  action through `menuExtraItems`, calling the same handler. */
  onLongPress?: () => void;
  /** Surface-specific ••• items (e.g. "Not part of this story"). */
  menuExtraItems?: readonly ArticleMenuItem[];
  /** Root testID passthrough (skill invariant 10). No visual effect. */
  testID?: string;
}

/**
 * The standalone compact article row: publisher-name semantics (source_uri →
 * domain fallback, __DEV__ cluster-confidence chip), layout from
 * `ArticleCompactCardBase`, and the compact action row (D3): like, not for me,
 * save, share, then ••• for everything else. Long-press opens the same menu
 * unless the surface supplies its own.
 *
 * Tapping the row navigates (`onPress`) to a detail screen; the row itself
 * opens the publisher only from the ••• menu, where the translate route sits
 * beside it.
 */
const ArticleStandaloneCompactCardImpl: React.FC<ArticleStandaloneCompactCardProps> = ({
  article,
  onPress,
  subjectExtras,
  onLongPress,
  menuExtraItems,
  testID,
}) => {
  const { t } = useTranslation();
  const publisherName =
    article.publicationSource?.publication_name ||
    (article.source_uri ? extractDomain(article.source_uri) : 'Source');
  const titleEnglish = article.title_en_internal_only ?? undefined;

  const subject = useMemo<FeedbackSubject>(
    () => ({
      origin: 'article',
      surface: 'detail',
      articleId: article._id,
      title: article.title_en_internal_only ?? article.title_en ?? article.title ?? '',
      category: article.category ?? null,
      pubDate: article.pubDate ?? null,
      publicationName: article.publicationSource?.publication_name ?? null,
      countryCode: article.publicationSource?.country_code ?? null,
      ...subjectExtras,
    }),
    // Callers pass `subjectExtras` as an inline literal; its fields, not its
    // identity, are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [article, JSON.stringify(subjectExtras ?? null)],
  );
  const share = useMemo(
    () => ({
      url: article.article_url ?? article.source_uri,
      titleEnglish: article.title_en_internal_only ?? article.title_en ?? article.title,
      titleOriginal: article.title,
      sourceLanguage: article.original_language_code,
    }),
    [article],
  );
  const visit = useMemo(() => visitFromArticle(article), [article]);

  const actions = useArticleActions({ subject, article, share, trackActive: false });
  const inlineActions = useMemo(
    () => inlineAccessibilityActions(t, actions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, actions.saved, actions.onLike, actions.onDislike, actions.onToggleSave, actions.onShare],
  );
  const menu = useArticleMenu({
    surface: 'card',
    subject,
    articleUrl: article.article_url ?? article.source_uri,
    languageCode: article.original_language_code,
    visit,
    // Answered on the detail screen, so the row opens it after asking.
    onCheckFacts: () => {
      // Required at call time: the fact-check client pulls in Apollo.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { requestArticleFactCheck } = require('@/lib/fact-check/request-article-fact-check') as typeof import('@/lib/fact-check/request-article-fact-check');
      const asked = requestArticleFactCheck({ articleId: article._id, title: subject.title, article });
      if (asked) onPress();
      return asked;
    },
    extraItems: menuExtraItems,
    inlineActions,
  });

  const metaAccessory =
    __DEV__ && typeof article.clusterConfidence === 'number' ? (
      <Box className="bg-amber-900/40 px-1.5 rounded">
        <Text size="xs" className="text-amber-300 font-mono">
          {article.clusterConfidence.toFixed(2)}
        </Text>
      </Box>
    ) : undefined;

  return (
    <>
      <ArticleCompactCardBase
        imageUrl={article.image_url}
        titleEnglish={titleEnglish}
        titleOriginal={article.title ?? undefined}
        sourceLanguage={article.original_language_code ?? undefined}
        pubDate={article.pubDate}
        languageCode={article.original_language_code}
        countryCode={article.publicationSource?.country_code}
        publicationName={publisherName}
        onPress={onPress}
        onLongPress={onLongPress ?? menu.open}
        metaAccessory={metaAccessory}
        testID={testID}
        footer={<ArticleActionBarFor actions={actions} onOverflow={menu.open} horizontalPadding={0} compact />}
        accessibilityActions={menu.accessibilityActions}
        onAccessibilityAction={menu.onAccessibilityAction}
      />
      {actions.element}
      {menu.element}
    </>
  );
};

export const ArticleStandaloneCompactCard = React.memo(ArticleStandaloneCompactCardImpl);

export default ArticleStandaloneCompactCard;
