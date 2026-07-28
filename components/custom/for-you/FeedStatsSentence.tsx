// FeedStatsSentence — the presentational "N articles published / M analysed /
// K relevant" line for the last 24h. Reads the shared `useFeedCounts()` hook and
// renders the same interpolation recipe the (now-deleted) ArticleCountForYouBanner
// used. Mounted in both the Feed tab header and the Dashboard header.

import { Text } from '@/components/ui/text';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { formatCount } from '@/lib/utils/format-count';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface FeedStatsSentenceProps {
  className?: string;
}

const FeedStatsSentence: React.FC<FeedStatsSentenceProps> = ({
  className = 'text-typography-400 leading-6',
}) => {
  const { t } = useTranslation();
  const appLanguage = useAppLanguage();
  const { articleCount, analysedCount, relevantCount } = useFeedCounts();

  const articleWord =
    articleCount === 1 ? t('feed.articleSingular') : t('feed.articlePlural');

  return (
    <Text size="sm" className={className}>
      {analysedCount === 0
        ? t('feed.analysedArticlesPending', {
            processed: formatCount(articleCount, appLanguage),
            articleWord,
          })
        : t('feed.analysedArticles', {
            processed: formatCount(articleCount, appLanguage),
            articleWord,
            analysed: formatCount(analysedCount, appLanguage),
            impactful: formatCount(relevantCount, appLanguage),
          })}
    </Text>
  );
};

export default FeedStatsSentence;
