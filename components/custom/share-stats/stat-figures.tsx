// The seven Stats figures (FinalLibrary #9, #11-13), ONE body per card id,
// drawn two ways: a card on the Stats page (pickable in select mode) and the
// shared image (inside CardShell, alone or packed with others). One body is
// what keeps the page and the image from ever disagreeing.
//
// Colour comes only from the palette in force (CardPaletteContext); sizes
// from `type()`, which always pairs fontSize with lineHeight. A figure with
// no data is never drawn as 0: the caller offers only `availableCards`.
//
// No "articles analysed by AI": no device-local record of it exists and one
// may not be created (reading-stats-source.ts carries why).

import { FlagGrid, HeatGrid, ProportionBar } from '@/components/custom/share-stats/card-charts';
import { SHELL_METRICS, type as textType } from '@/components/custom/share-stats/card-shell';
import { useCardInk } from '@/components/custom/share-stats/card-theme';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getLocalizedLanguageName } from '@/lib/language-names';
import { peakDayCount, roundedMedianHours, type ReadingStats, type StatsCardId, WINDOW_DAYS } from '@/lib/stats/reading-stats';
import type { TFunction } from 'i18next';
import React from 'react';
import { useTranslation } from 'react-i18next';

/** Languages named on the bar; beyond this the remainder band carries them. */
const LANGUAGES_TOP_N = 4;

/** Sizes per surface, in design points (the image scales by its host). */
const SIZES = {
  tile: { figure: 30, line: 13, gap: 8 },
  image: { figure: 56, line: 15, gap: 14 },
  /** Several figures sharing one image (owner: as many per image as fit). */
  packed: { figure: 32, line: 12, gap: 8 },
} as const;

/** Charts on a packed image draw at this share of their image size; their
 *  text keeps its size (the 9.5pt floor). */
const PACKED_CHART_SCALE = 0.6;

export type StatVariant = keyof typeof SIZES;

/** The card's name ("Publications"). */
export function statLabel(t: TFunction, id: StatsCardId): string {
  switch (id) {
    case 'publications':
      return t('library.stats.publications');
    case 'languages':
      return t('library.stats.languages');
    case 'days':
      return t('library.stats.days');
    case 'opened':
      return t('library.stats.opened');
    case 'fresh':
      return t('library.stats.fresh');
    case 'now':
      return t('library.stats.now');
    case 'top':
      return t('library.stats.top');
  }
}

/** The image's one window statement: "{Card} · last 30 days", or "Right now"
 *  alone for the present-tense card (two windows never share a heading). */
export function statWindowTitle(t: TFunction, id: StatsCardId): string {
  return id === 'now' ? t('library.stats.now') : t('shareStats.card.windowLine', { label: statLabel(t, id) });
}

interface Props {
  readonly id: StatsCardId;
  readonly stats: ReadingStats;
  readonly variant: StatVariant;
  /** Design-grid scale (the image's host width / 360); 1 on the page. */
  readonly k?: number;
}

/** A big number, then the words that say what it counts. */
function FigureLine({ figure, line, variant, k }: { figure: string; line?: string | null; variant: StatVariant; k: number }) {
  const { ink } = useCardInk();
  const s = SIZES[variant];
  const block = variant !== 'tile';
  const figureNode = (
    <Text
      allowFontScaling={false}
      numberOfLines={1}
      style={[textType(s.figure, k, SHELL_METRICS.numeralLeading), ink('primary'), { fontWeight: '700' }]}
    >
      {figure}
    </Text>
  );
  const lineNode = line ? (
    <Text allowFontScaling={false} style={[textType(s.line, k), ink('secondary'), block ? null : { flexShrink: 1 }]}>
      {line}
    </Text>
  ) : null;
  // The image stacks the line under the figure; a page card runs it beside.
  return block ? (
    <VStack>
      {figureNode}
      {lineNode}
    </VStack>
  ) : (
    <HStack className="items-baseline flex-wrap" style={{ columnGap: 8 * k }}>
      {figureNode}
      {lineNode}
    </HStack>
  );
}

const StatFigure: React.FC<Props> = ({ id, stats, variant, k = 1 }) => {
  const { t, i18n } = useTranslation();
  const s = SIZES[variant];
  const ck = variant === 'packed' ? k * PACKED_CHART_SCALE : k;

  let body: React.ReactNode = null;
  switch (id) {
    case 'publications':
      body = (
        <>
          <FigureLine
            figure={String(stats.publicationCount)}
            line={t('library.stats.pubsInCountries', { count: stats.countryCount })}
            variant={variant}
            k={k}
          />
          {stats.countries.length > 0 ? (
            <FlagGrid
              countryCodes={stats.countries.map((c) => c.countryCode)}
              k={ck}
              textK={k}
              overflowLabel={(n) => t('shareStats.card.flagsMore', { n })}
              testID={`stat-${id}-flags`}
            />
          ) : null}
        </>
      );
      break;
    case 'languages': {
      const total = stats.languages.reduce((sum, l) => sum + l.visitCount, 0);
      const lead = stats.languages.slice(0, LANGUAGES_TOP_N);
      const rest = total - lead.reduce((sum, l) => sum + l.visitCount, 0);
      const segments =
        total > 0
          ? [
              ...lead.map((l, i) => ({
                id: l.languageCode,
                share: l.visitCount / total,
                accent: i === 0,
                label: `${getLocalizedLanguageName(l.languageCode, i18n.language) ?? l.languageCode.toUpperCase()} ${Math.round((l.visitCount / total) * 100)}%`,
              })),
              ...(rest > 0 ? [{ id: 'rest', share: rest / total, label: t('shareStats.card.countriesRest') }] : []),
            ]
          : [];
      body = (
        <>
          <FigureLine figure={String(stats.languageCount)} line={t('library.stats.languagesLine')} variant={variant} k={k} />
          {segments.length > 0 ? <ProportionBar segments={segments} k={ck} textK={k} testID={`stat-${id}-bar`} /> : null}
        </>
      );
      break;
    }
    case 'days':
      body = (
        <>
          <FigureLine
            figure={String(stats.daysReadCount)}
            line={t('library.stats.daysLine', { days: WINDOW_DAYS })}
            variant={variant}
            k={k}
          />
          <HeatGrid
            days={stats.days}
            peak={peakDayCount(stats.days)}
            k={ck}
            textK={k}
            weekdayInitials={t('shareStats.card.rhythmWeekdays').split(',').map((d) => d.trim())}
            legendLess={t('shareStats.card.heatLegendLess')}
            legendMore={t('shareStats.card.heatLegendMore')}
            testID={`stat-${id}-heat`}
          />
        </>
      );
      break;
    case 'opened':
      body = <FigureLine figure={String(stats.openedAtSourceCount)} line={t('library.stats.openedLine')} variant={variant} k={k} />;
      break;
    case 'fresh': {
      const hours = roundedMedianHours(stats.publishToRead) ?? 0;
      body = (
        <FigureLine
          figure={t('shareStats.card.hoursShort', { n: hours })}
          line={t('library.stats.freshLine', { count: hours })}
          variant={variant}
          k={k}
        />
      );
      break;
    }
    case 'now':
      body = (
        <>
          {stats.keptNow.savedArticles > 0 ? (
            <FigureLine
              figure={String(stats.keptNow.savedArticles)}
              line={t('library.stats.savedLine', { count: stats.keptNow.savedArticles })}
              variant={variant}
              k={k}
            />
          ) : null}
          {stats.keptNow.followedStories > 0 ? (
            <FigureLine
              figure={String(stats.keptNow.followedStories)}
              line={t('library.stats.followedLine', { count: stats.keptNow.followedStories })}
              variant={variant}
              k={k}
            />
          ) : null}
        </>
      );
      break;
    case 'top': {
      // Names leave the phone ONLY through this card, and only if picked.
      const [first, second, third] = stats.topPublications;
      const line = third
        ? t('library.stats.topLine', { second: second.publicationName, third: third.publicationName })
        : second
          ? t('library.stats.topLineOne', { second: second.publicationName })
          : null;
      body = first ? <FigureLine figure={first.publicationName} line={line} variant={variant} k={k} /> : null;
      break;
    }
  }

  return (
    <VStack style={{ rowGap: s.gap * k }} testID={`stat-figure-${id}`}>
      {body}
    </VStack>
  );
};

export default StatFigure;
