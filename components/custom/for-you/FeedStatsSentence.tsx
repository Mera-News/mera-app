// FeedStatsSentence — the presentational "N articles published / M analysed /
// K relevant" line for the last 24h. Reads the shared `useFeedCounts()` hook and
// renders the same interpolation recipe the (now-deleted) ArticleCountForYouBanner
// used. Mounted in both the Feed tab header and the Dashboard header.

import { Text } from '@/components/ui/text';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface FeedStatsSentenceProps {
  className?: string;
}

const FeedStatsSentence: React.FC<FeedStatsSentenceProps> = ({
  className = 'text-typography-400 leading-6',
}) => {
  const { t } = useTranslation();
  const { articleCount, analysedCount, relevantCount } = useFeedCounts();

  const articleWord =
    articleCount === 1 ? t('feed.articleSingular') : t('feed.articlePlural');

  return (
    <Text size="sm" className={className}>
      {analysedCount === 0
        ? t('feed.analysedArticlesPending', {
            processed: articleCount,
            articleWord,
          })
        : t('feed.analysedArticles', {
            processed: articleCount,
            articleWord,
            analysed: analysedCount,
            impactful: relevantCount,
          })}
    </Text>
  );
};

export default FeedStatsSentence;
