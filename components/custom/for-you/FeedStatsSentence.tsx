// FeedStatsSentence — the presentational "N published / M analysed / K relevant
// / R read" line. Reads the shared `useFeedCounts()` hook. Mounted in both the
// Feed tab header and the Dashboard header.
//
// PLURALS: each clause is its own i18next key with a `count` option, so the
// library picks the right plural form per language (`_one`/`_other` in en, and
// up to six forms in ar/pl/ru — `compatibilityJSON: 'v4'`, see lib/i18n/index.ts).
// The previous single-string version interpolated a hand-picked
// `articleSingular`/`articlePlural` word, which is wrong in every language with
// more than two forms AND in every language where the verb agrees too. The
// grouped number is passed separately as `formatted` because `count` must stay a
// raw number for the plural resolver — `formatCount` output ("1,024") is a
// string and would break it.

import { Text } from '@/components/ui/text';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { useImportanceFilterStore } from '@/lib/stores/importance-filter-store';
import { formatCount } from '@/lib/utils/format-count';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface FeedStatsSentenceProps {
  className?: string;
  /** Count "relevant" against the FEED's importance threshold, so the sentence
   *  can't advertise more stories than the filtered list under it shows. Opt-in
   *  because the Dashboard persists its own (different) threshold and must keep
   *  the unfiltered counts. */
  importanceAware?: boolean;
}

/** The five clause keys, spelled out as literals so the typed `t()` still
 *  checks them — a plain `string` parameter drops to the overload that demands
 *  a default value. */
type StatsClauseKey =
  | 'feed.statsPublished'
  | 'feed.statsPublishedPending'
  | 'feed.statsAnalysed'
  | 'feed.statsRelevant'
  | 'feed.statsRead';

const FeedStatsSentence: React.FC<FeedStatsSentenceProps> = ({
  // No `leading-6`: 21px on 16px type (1.31) is a Latin-sized line box. This
  // sentence is translated into 20 languages, and Devanagari/Thai marks sit
  // above it. The `md` token's own 24px line box applies instead.
  className = 'text-typography-400',
  importanceAware = false,
}) => {
  const { t } = useTranslation();
  const appLanguage = useAppLanguage();
  const feedThreshold = useImportanceFilterStore((s) => s.feedThreshold);
  const { articleCount, analysedCount, relevantCount, readCount } = useFeedCounts(
    importanceAware ? feedThreshold : undefined,
  );

  const clause = (key: StatsClauseKey, count: number) =>
    t(key, { count, formatted: formatCount(count, appLanguage) });

  // Nothing scored yet: the published count is the only honest number, so the
  // sentence is that clause alone (it carries its own full stop).
  const sentence =
    analysedCount === 0
      ? clause('feed.statsPublishedPending', articleCount)
      : [
          clause('feed.statsPublished', articleCount),
          clause('feed.statsAnalysed', analysedCount),
          clause('feed.statsRelevant', relevantCount),
          clause('feed.statsRead', readCount),
        ].join(' ');

  return (
    <Text size="sm" className={className}>
      {sentence}
    </Text>
  );
};

export default FeedStatsSentence;
