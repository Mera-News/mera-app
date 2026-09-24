// The three stats cards: reach and habits (last 30 days), keep (right now).
//
// There used to be five, one idea each, and most of each card was empty
// space. They were merged along the WINDOW line and never across it. Each card
// carries its OWN metrics object and its own worst-case entry in
// `share-stats-locale-budget`, because a single shared object means a size
// change made for one card silently overflows another in a locale nobody
// rendered.
//
// ## One window statement per card, and the cards are split along it
//
// Countries, publications, languages, days read, opened and publish-to-read
// are 30-day. Saved and followed are PRESENT TENSE and cannot honestly sit
// under a 30-day heading, so the keep card is the present-tense one and says
// so in its own window line.
//
// ## Nothing is drawn as a zero
//
// A figure with nothing behind it is left off its card rather than printed as
// 0, and a card is offered only when one of its figures has data
// (`cardHasData`).
//
// ## The text floor
//
// No text on a card is below 9.5 design points, 28.5px at the 1080px export.
//
// ## What is NOT here
//
// No "articles analysed by AI". No device-local record of it exists and one may
// not be created; `reading-stats-source.ts` carries the seven candidates and
// why each fails. A server-read figure would also falsify the footer line every
// card ends on.

import {
  CHART_METRICS,
  DotArray,
  FlagGrid,
  HeatGrid,
  ProportionBar,
  RuledScale,
} from '@/components/custom/share-stats/card-charts';
import CardShell, {
  DESIGN_WIDTH,
  SHELL_METRICS,
  hostSizeForScale,
  type as textType,
} from '@/components/custom/share-stats/card-shell';
import { ink } from '@/components/custom/share-stats/card-theme';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getFlagEmoji } from '@/lib/country-utils';
import {
  countryBands,
  peakDayCount,
  roundedAverageHours,
  type ReadingStats,
} from '@/lib/stats/reading-stats';
import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

/** The pace card's scale runs 0 to 48 hours. Two days is the span a news
 *  latency average actually lives in; a longer axis crushes every real value
 *  into the first tenth of the rule and stops being readable. */
export const PACE_SCALE_MAX_HOURS = 48;

/** Top countries named on the reach card's proportion bar. Three plus a
 *  remainder is what fits the legend on one line in the widest locale. */
export const REACH_TOP_COUNTRIES = 3;

/** Languages named on the reach card's language bar. Beyond this the bar's
 *  remainder band carries them. */
export const LANGUAGES_TOP_N = 4;

export const REACH_METRICS = {
  numeral: 30,
  numeralLabel: 9.5,
  numeralLabelGap: 3,
  tileGap: 10,
  tilePadding: 10,
  blockGap: 12,
  listTitle: 9.5,
  listTitleGap: 6,
  rowText: 11,
  rowGap: 4,
  statLabel: 11,
  statNumeral: 20,
  /** Top publications named, at most. */
  publicationRows: 3,
} as const;

export const HABITS_METRICS = {
  blockGap: 12,
  statLabel: 11,
  statNumeral: 20,
  scaleValueGap: 3,
} as const;

export const KEEP_METRICS = {
  numeral: 44,
  numeralLabel: 11,
  numeralLabelGap: 3,
  blockGap: 22,
  dotsGap: 9,
  note: 9.5,
} as const;

export interface StatsCardProps {
  stats: ReadingStats;
  pixelRatio: number;
  /** When the card was made. Stamped at CAPTURE time on the share path. */
  stampedAtMs: number;
  /** BCP-47 tag for the date. Undefined means the platform default. */
  locale?: string;
  /** Explicit host size in POINTS for the on-screen path. Omitted = export. */
  hostSize?: { width: number; height: number };
  /**
   * Whether the reach card names the reader's top publications.
   *
   * DEFAULT ON, and the control that turns it off is still on the preview
   * screen. Safe to default on because the setting is per-share SESSION state
   * (`useState` in `ShareStatsPreviewScreen`, no setting row, no store), so no
   * reader has ever stored a deliberate "off" that this could overwrite. If it
   * is ever persisted, a stored `false` must win over this default: a default
   * is for people who have not chosen.
   *
   * The control stays even though the default flipped. This card is made to be
   * posted in public and publication names are revealing, so removing the only
   * way to decline is a different decision from changing what happens when the
   * reader does not choose. Article titles are never included under any
   * setting, by any path.
   */
  showPublicationNames?: boolean;
}

/** The design-grid scale for whichever host the card is being drawn into. The
 *  on-screen host is fitted to the content-box ratio and is usually SMALLER
 *  than the export host, so reading `k` off the export would draw type that
 *  overflows the page it is actually in. */
function useK(pixelRatio: number, hostSize?: { width: number; height: number }): number {
  const width = hostSize?.width ?? hostSizeForScale(pixelRatio).width;
  return width / DESIGN_WIDTH;
}

/** A figure and the label that names it. The label is never in the accent and
 *  never the same weight as the numeral: one reading order per block. */
const Figure: React.FC<{
  value: string;
  label: string;
  k: number;
  size: number;
  labelSize: number;
  labelGap: number;
  testID: string;
}> = ({ value, label, k, size, labelSize, labelGap, testID }) => (
  <VStack testID={testID}>
    <Text
      allowFontScaling={false}
      className="font-semibold"
      style={[textType(size, k, SHELL_METRICS.numeralLeading), ink('primary')]}
    >
      {value}
    </Text>
    <Text
      allowFontScaling={false}
      style={[textType(labelSize, k), { marginTop: labelGap * k }, ink('secondary')]}
    >
      {label}
    </Text>
  </VStack>
);

/** A label on the left and its figure on the right, one row. The compact form
 *  the merged cards use: a stacked numeral per figure is what made the old
 *  one-idea cards tall and empty. */
const StatRow: React.FC<{
  label: string;
  value: string;
  k: number;
  labelSize: number;
  numeralSize: number;
  testID: string;
}> = ({ label, value, k, labelSize, numeralSize, testID }) => (
  <HStack testID={testID} className="items-center" style={{ columnGap: 10 * k }}>
    <Text
      allowFontScaling={false}
      style={[textType(labelSize, k), { flex: 1 }, ink('secondary')]}
    >
      {label}
    </Text>
    <Text
      allowFontScaling={false}
      className="font-semibold"
      style={[textType(numeralSize, k, SHELL_METRICS.numeralLeading), { flexShrink: 0 }, ink('primary')]}
    >
      {value}
    </Text>
  </HStack>
);

// --- 1. REACH (last 30 days) -----------------------------------------------

export const ReachCard = React.forwardRef<View, StatsCardProps>(function ReachCard(
  { stats, pixelRatio, stampedAtMs, locale, hostSize, showPublicationNames = true },
  ref,
) {
  const { t } = useTranslation();
  const k = useK(pixelRatio, hostSize);
  const m = REACH_METRICS;

  const countrySegments = countryBands(stats, REACH_TOP_COUNTRIES).map((band, index) => ({
    id: band.countryCode ?? 'rest',
    share: band.share,
    accent: index === 0,
    label:
      band.countryCode === null
        ? t('shareStats.card.countriesRest')
        // Flag plus percent, no country NAME: a name needs a localised country
        // list this app does not carry, and the flag is already the grid's
        // vocabulary one block up.
        : `${getFlagEmoji(band.countryCode) ?? band.countryCode} ${Math.round(band.share * 100)}%`,
  }));

  const languageTotal = stats.languages.reduce((sum, l) => sum + l.visitCount, 0);
  const languageLead = stats.languages.slice(0, LANGUAGES_TOP_N);
  const languageLeadTotal = languageLead.reduce((sum, l) => sum + l.visitCount, 0);
  const languageSegments = languageTotal > 0
    ? [
        ...languageLead.map((language, index) => ({
          id: language.languageCode,
          share: language.visitCount / languageTotal,
          accent: index === 0,
          // Codes, not names: four full language names in a row overflow in
          // every locale.
          label: language.languageCode.toUpperCase(),
        })),
        ...(languageTotal - languageLeadTotal > 0
          ? [{
              id: 'rest',
              share: (languageTotal - languageLeadTotal) / languageTotal,
              label: t('shareStats.card.countriesRest'),
            }]
          : []),
      ]
    : [];

  const showCountries = stats.countryCount > 0;
  const showPublications = stats.publicationCount > 0;
  const tile = (value: number, label: string, testID: string) => (
    <Box className="flex-1 rounded-lg border border-white" style={{ padding: m.tilePadding * k }}>
      <Figure
        value={String(value)}
        label={label}
        k={k}
        size={m.numeral}
        labelSize={m.numeralLabel}
        labelGap={m.numeralLabelGap}
        testID={testID}
      />
    </Box>
  );

  return (
    <CardShell
      ref={ref}
      title={t('shareStats.card.reachTitle')}
      windowLine={t('shareStats.screenSubtitle')}
      privacyLine={t('shareStats.card.privacyLine')}
      pixelRatio={pixelRatio}
      stampedAtMs={stampedAtMs}
      locale={locale}
      hostSize={hostSize}
      testID="share-stats-card-reach"
    >
      <VStack style={{ rowGap: m.blockGap * k }}>
        {showCountries || showPublications ? (
          <HStack style={{ columnGap: m.tileGap * k }}>
            {showCountries
              ? tile(stats.countryCount, t('shareStats.card.countriesLabel'), 'share-stats-reach-countries')
              : null}
            {showPublications
              ? tile(stats.publicationCount, t('shareStats.card.publicationsLabel'), 'share-stats-reach-publications')
              : null}
          </HStack>
        ) : null}

        {showCountries ? (
          <FlagGrid
            countryCodes={stats.countries.map((c) => c.countryCode)}
            k={k}
            maxCells={CHART_METRICS.flagOneRowCells}
            overflowLabel={(n) => t('shareStats.card.flagsMore', { n })}
            testID="share-stats-reach-flags"
          />
        ) : null}

        {countrySegments.length > 0 ? (
          <VStack>
            <Text
              allowFontScaling={false}
              style={[textType(m.listTitle, k), { marginBottom: m.listTitleGap * k }, ink('muted')]}
            >
              {t('shareStats.card.topCountriesTitle')}
            </Text>
            <ProportionBar segments={countrySegments} k={k} testID="share-stats-reach-bar" />
          </VStack>
        ) : null}

        {stats.languageCount > 0 ? (
          <VStack testID="share-stats-reach-languages" style={{ rowGap: m.listTitleGap * k }}>
            <StatRow
              label={t('shareStats.card.languagesLabel')}
              value={String(stats.languageCount)}
              k={k}
              labelSize={m.statLabel}
              numeralSize={m.statNumeral}
              testID="share-stats-reach-languages-count"
            />
            {languageSegments.length > 0 ? (
              <ProportionBar segments={languageSegments} k={k} testID="share-stats-reach-languages-bar" />
            ) : null}
          </VStack>
        ) : null}

        {/* ABSENT rather than empty when off, so the card has two clean
            vertical arrangements instead of a hole where a list would be. */}
        {showPublicationNames && stats.topPublications.length > 0 ? (
          <VStack testID="share-stats-reach-top-publications">
            <Text
              allowFontScaling={false}
              style={[textType(m.listTitle, k), { marginBottom: m.listTitleGap * k }, ink('muted')]}
            >
              {t('shareStats.card.topPublicationsTitle')}
            </Text>
            {stats.topPublications.slice(0, m.publicationRows).map((publication) => (
              <HStack
                key={`${publication.publicationName}::${publication.countryCode ?? ''}`}
                className="items-center"
                style={{ columnGap: 8 * k, marginTop: m.rowGap * k }}
              >
                <SourceFlag countryCode={publication.countryCode} size="lg" iconClassName="text-white" />
                <Text
                  allowFontScaling={false}
                  style={[textType(m.rowText, k), ink('primary')]}
                  numberOfLines={1}
                >
                  {publication.publicationName}
                </Text>
              </HStack>
            ))}
          </VStack>
        ) : null}
      </VStack>
    </CardShell>
  );
});

// --- 2. HABITS (last 30 days) ----------------------------------------------

export const HabitsCard = React.forwardRef<View, StatsCardProps>(function HabitsCard(
  { stats, pixelRatio, stampedAtMs, locale, hostSize },
  ref,
) {
  const { t } = useTranslation();
  const k = useK(pixelRatio, hostSize);
  const m = HABITS_METRICS;

  // Seven initials, Monday first, from ONE comma-separated key rather than
  // seven keys. Duplicates within a locale are expected and correct (en T/T
  // and S/S): position carries the meaning, not the letter.
  const weekdays = t('shareStats.card.rhythmWeekdays').split(',').map((d) => d.trim());
  const averageHours = roundedAverageHours(stats.publishToRead);
  const { sampledArticles, totalArticles } = stats.publishToRead;

  return (
    <CardShell
      ref={ref}
      title={t('shareStats.card.habitsTitle')}
      windowLine={t('shareStats.screenSubtitle')}
      privacyLine={t('shareStats.card.privacyLine')}
      pixelRatio={pixelRatio}
      stampedAtMs={stampedAtMs}
      locale={locale}
      hostSize={hostSize}
      testID="share-stats-card-habits"
    >
      <VStack style={{ rowGap: m.blockGap * k }}>
        {stats.daysReadCount > 0 ? (
          <VStack style={{ rowGap: 6 * k }}>
            <StatRow
              // "Days you READ something", never "days you opened the app".
              // There is no app-open record, no session row and no launch
              // counter anywhere in the schema.
              label={t('shareStats.card.daysReadLabel')}
              value={String(stats.daysReadCount)}
              k={k}
              labelSize={m.statLabel}
              numeralSize={m.statNumeral}
              testID="share-stats-habits-days"
            />
            <HeatGrid
              days={stats.days}
              peak={peakDayCount(stats.days)}
              k={k}
              weekdayInitials={weekdays}
              legendLess={t('shareStats.card.heatLegendLess')}
              legendMore={t('shareStats.card.heatLegendMore')}
              testID="share-stats-habits-grid"
            />
          </VStack>
        ) : null}

        {stats.articlesOpened > 0 ? (
          <VStack>
            <StatRow
              label={t('shareStats.card.openedLabel')}
              value={String(stats.articlesOpened)}
              k={k}
              labelSize={m.statLabel}
              numeralSize={m.statNumeral}
              testID="share-stats-habits-opened"
            />
            {/* The partial qualifier sits under its own figure, never in a
                collected footnote. "Articles opened" counts suggestion-card
                taps only, and saying so is the claim that keeps it true. */}
            <Text
              allowFontScaling={false}
              testID="share-stats-habits-opened-partial"
              style={[
                textType(SHELL_METRICS.qualifier, k),
                { marginTop: SHELL_METRICS.qualifierGap * k },
                ink('muted'),
              ]}
            >
              {t('shareStats.card.openedPartial')}
            </Text>
          </VStack>
        ) : null}

        {/* Null is NOT zero: zero would read as "instant". With no average the
            whole block is left off, like any figure with nothing behind it. */}
        {averageHours !== null ? (
          <VStack>
            <StatRow
              label={t('shareStats.card.paceScaleTitle')}
              value={t('shareStats.card.latencyValue', { count: averageHours })}
              k={k}
              labelSize={m.statLabel}
              numeralSize={m.statNumeral}
              testID="share-stats-habits-pace-value"
            />
            <View style={{ marginTop: m.scaleValueGap * k }}>
              <RuledScale
                value={averageHours}
                min={0}
                max={PACE_SCALE_MAX_HOURS}
                k={k}
                startLabel={t('shareStats.card.hoursShort', { n: 0 })}
                endLabel={t('shareStats.card.hoursShort', { n: PACE_SCALE_MAX_HOURS })}
                testID="share-stats-habits-pace-scale"
              />
            </View>
            {/* The denominator is inline and always present when there IS an
                average. A bare average over the covered subset, presented as
                the whole, is the specific claim this line refuses. */}
            <Text
              allowFontScaling={false}
              testID="share-stats-habits-pace-coverage"
              style={[
                textType(SHELL_METRICS.qualifier, k),
                { marginTop: CHART_METRICS.scaleLabelTop * k },
                ink('muted'),
              ]}
            >
              {t('shareStats.card.latencyCoverage', { sampled: sampledArticles, total: totalArticles })}
            </Text>
          </VStack>
        ) : null}
      </VStack>
    </CardShell>
  );
});

// --- 3. KEEP (right now) ---------------------------------------------------

export const KeepCard = React.forwardRef<View, StatsCardProps>(function KeepCard(
  { stats, pixelRatio, stampedAtMs, locale, hostSize },
  ref,
) {
  const { t } = useTranslation();
  const k = useK(pixelRatio, hostSize);
  const m = KEEP_METRICS;
  const { savedArticles, followedStories } = stats.keptNow;

  return (
    <CardShell
      ref={ref}
      title={t('shareStats.card.keepTitle')}
      // PRESENT TENSE. These two figures are states the reader is in now, not
      // events inside a window, so this card never claims 30 days.
      windowLine={t('shareStats.card.windowNow')}
      privacyLine={t('shareStats.card.privacyLine')}
      pixelRatio={pixelRatio}
      stampedAtMs={stampedAtMs}
      locale={locale}
      hostSize={hostSize}
      testID="share-stats-card-keep"
    >
      <VStack style={{ rowGap: m.blockGap * k }}>
        {savedArticles > 0 ? (
          <VStack style={{ rowGap: m.dotsGap * k }}>
            <Figure
              value={String(savedArticles)}
              label={t('shareStats.card.savedLabel')}
              k={k}
              size={m.numeral}
              labelSize={m.numeralLabel}
              labelGap={m.numeralLabelGap}
              testID="share-stats-keep-saved"
            />
            <DotArray count={savedArticles} k={k} shape="filled" testID="share-stats-keep-saved-dots" />
          </VStack>
        ) : null}

        {followedStories > 0 ? (
          <VStack style={{ rowGap: m.dotsGap * k }}>
            <Figure
              value={String(followedStories)}
              label={t('shareStats.card.followedLabel')}
              k={k}
              size={m.numeral}
              labelSize={m.numeralLabel}
              labelGap={m.numeralLabelGap}
              testID="share-stats-keep-followed"
            />
            {/* Rings, not filled dots, and in the accent: the two arrays sit one
                above the other, so they have to be told apart by SHAPE rather
                than only by colour. */}
            <DotArray
              count={followedStories}
              k={k}
              shape="ring"
              accent
              testID="share-stats-keep-followed-dots"
            />
          </VStack>
        ) : null}

        <Text
          allowFontScaling={false}
          testID="share-stats-keep-note"
          style={[textType(m.note, k), ink('muted')]}
        >
          {t('shareStats.card.keepNote')}
        </Text>
      </VStack>
    </CardShell>
  );
});
