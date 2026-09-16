// The three stats cards. Breadth, intent, reading.
//
// Each is one idea with two figures and its own chart form, so the set does not
// read as one card printed three times. Each also carries its OWN metrics
// object and its own worst-case entry in `share-stats-locale-budget`, because a
// single shared object means a size change made for one card silently overflows
// another in a locale nobody rendered.
//
// ## One window statement per card, and the cards are split along it
//
// Countries, publications, opened and publish-to-read are 30-day. Saved and
// followed are PRESENT TENSE and cannot honestly sit under a 30-day heading,
// so the keep card is the present-tense one and says so in its own window line.
// That is not a workaround for the split; the split is why the three cards
// divide where they do.
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
import { getLocalizedLanguageName } from '@/lib/language-names';
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

export const REACH_METRICS = {
  numeral: 34,
  numeralLabel: 9.5,
  numeralLabelGap: 3,
  tileGap: 10,
  tilePadding: 11,
  blockGap: 16,
  listTitle: 9.5,
  listTitleGap: 7,
  rowText: 11,
  rowGap: 5,
} as const;

export const KEEP_METRICS = {
  numeral: 44,
  numeralLabel: 11,
  numeralLabelGap: 3,
  blockGap: 22,
  dotsGap: 9,
  note: 8.5,
} as const;

export const LANGUAGES_METRICS = {
  numeral: 44,
  numeralLabel: 11,
  numeralLabelGap: 3,
  blockGap: 22,
  listTitle: 9.5,
  listTitleGap: 8,
  rowText: 11,
  rowGap: 6,
  rowPercent: 10,
} as const;

/** Languages named on the card. Beyond this the bar's remainder band carries
 *  them, so the list never grows the card in a way the budget cannot model. */
export const LANGUAGES_TOP_N = 4;

export const RHYTHM_METRICS = {
  numeral: 44,
  numeralLabel: 11,
  numeralLabelGap: 3,
  blockGap: 18,
  note: 8.5,
} as const;

export const PACE_METRICS = {
  numeral: 44,
  numeralLabel: 11,
  numeralLabelGap: 3,
  blockGap: 20,
  scaleTitle: 9.5,
  scaleTitleGap: 8,
  scaleValue: 26,
  scaleValueGap: 4,
} as const;

export interface StatsCardProps {
  stats: ReadingStats;
  pixelRatio: number;
  /** When the card was made. Stamped at CAPTURE time on the share path. */
  stampedAtMs: number;
  /** BCP-47 tag for the date. Undefined means the platform default. */
  locale?: string;
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

function useK(pixelRatio: number): number {
  return hostSizeForScale(pixelRatio).width / DESIGN_WIDTH;
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

// --- 1. REACH --------------------------------------------------------------

export const ReachCard = React.forwardRef<View, StatsCardProps>(function ReachCard(
  { stats, pixelRatio, stampedAtMs, locale, showPublicationNames = true },
  ref,
) {
  const { t } = useTranslation();
  const k = useK(pixelRatio);
  const m = REACH_METRICS;

  const bands = countryBands(stats, REACH_TOP_COUNTRIES);
  const segments = bands.map((band, index) => ({
    id: band.countryCode ?? 'rest',
    share: band.share,
    accent: index === 0,
    label:
      band.countryCode === null
        ? t('shareStats.card.countriesRest')
        // Flag plus percent, no country NAME: a name needs a localised country
        // list this app does not carry, and the flag is already the grid's
        // vocabulary two blocks up.
        : `${getFlagEmoji(band.countryCode) ?? band.countryCode} ${Math.round(band.share * 100)}%`,
  }));

  return (
    <CardShell
      ref={ref}
      title={t('shareStats.card.reachTitle')}
      windowLine={t('shareStats.screenSubtitle')}
      privacyLine={t('shareStats.card.privacyLine')}
      pixelRatio={pixelRatio}
      stampedAtMs={stampedAtMs}
      locale={locale}
      testID="share-stats-card-reach"
    >
      <VStack style={{ rowGap: m.blockGap * k }}>
        <HStack style={{ columnGap: m.tileGap * k }}>
          <Box className="flex-1 rounded-lg border border-white" style={{ padding: m.tilePadding * k }}>
            <Figure
              value={String(stats.countryCount)}
              label={t('shareStats.card.countriesLabel')}
              k={k}
              size={m.numeral}
              labelSize={m.numeralLabel}
              labelGap={m.numeralLabelGap}
              testID="share-stats-reach-countries"
            />
          </Box>
          <Box className="flex-1 rounded-lg border border-white" style={{ padding: m.tilePadding * k }}>
            <Figure
              value={String(stats.publicationCount)}
              label={t('shareStats.card.publicationsLabel')}
              k={k}
              size={m.numeral}
              labelSize={m.numeralLabel}
              labelGap={m.numeralLabelGap}
              testID="share-stats-reach-publications"
            />
          </Box>
        </HStack>

        <FlagGrid
          countryCodes={stats.countries.map((c) => c.countryCode)}
          k={k}
          overflowLabel={(n) => t('shareStats.card.flagsMore', { n })}
          testID="share-stats-reach-flags"
        />

        {segments.length > 0 ? (
          <VStack>
            <Text
              allowFontScaling={false}
              style={[
                textType(m.listTitle, k),
                { marginBottom: m.listTitleGap * k },
                ink('muted'),
              ]}
            >
              {t('shareStats.card.topCountriesTitle')}
            </Text>
            <ProportionBar segments={segments} k={k} testID="share-stats-reach-bar" />
          </VStack>
        ) : null}

        {/* ABSENT rather than empty when off, so the card has two clean
            vertical arrangements instead of a hole where a list would be. */}
        {showPublicationNames && stats.topPublications.length > 0 ? (
          <VStack testID="share-stats-reach-top-publications">
            <Text
              allowFontScaling={false}
              style={[
                textType(m.listTitle, k),
                { marginBottom: m.listTitleGap * k },
                ink('muted'),
              ]}
            >
              {t('shareStats.card.topPublicationsTitle')}
            </Text>
            {stats.topPublications.map((publication) => (
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

// --- 2. KEEP ---------------------------------------------------------------

export const KeepCard = React.forwardRef<View, StatsCardProps>(function KeepCard(
  { stats, pixelRatio, stampedAtMs, locale },
  ref,
) {
  const { t } = useTranslation();
  const k = useK(pixelRatio);
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
      testID="share-stats-card-keep"
    >
      <VStack style={{ rowGap: m.blockGap * k }}>
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

// --- 3. LANGUAGES ----------------------------------------------------------

export const LanguagesCard = React.forwardRef<View, StatsCardProps>(function LanguagesCard(
  { stats, pixelRatio, stampedAtMs, locale },
  ref,
) {
  const { t } = useTranslation();
  const k = useK(pixelRatio);
  const m = LANGUAGES_METRICS;

  const total = stats.languages.reduce((sum, l) => sum + l.visitCount, 0);
  const lead = stats.languages.slice(0, LANGUAGES_TOP_N);
  const leadTotal = lead.reduce((sum, l) => sum + l.visitCount, 0);

  const segments = total > 0
    ? [
        ...lead.map((language, index) => ({
          id: language.languageCode,
          share: language.visitCount / total,
          accent: index === 0,
          // The BAR's legend is codes, not names: four full language names in
          // a row overflow in every locale, and the named list directly below
          // already carries the words.
          label: language.languageCode.toUpperCase(),
        })),
        ...(total - leadTotal > 0
          ? [{ id: 'rest', share: (total - leadTotal) / total, label: t('shareStats.card.countriesRest') }]
          : []),
      ]
    : [];

  return (
    <CardShell
      ref={ref}
      // The TITLE does this card's labelling work, so the figure below is a
      // bare numeral. Minting a separate `languagesTitle` would have put
      // "Languages you read in" on the card twice, two lines apart, and cost a
      // third splice round for a string the reader would read as a mistake.
      title={t('shareStats.card.languagesLabel')}
      windowLine={t('shareStats.screenSubtitle')}
      privacyLine={t('shareStats.card.privacyLine')}
      pixelRatio={pixelRatio}
      stampedAtMs={stampedAtMs}
      locale={locale}
      testID="share-stats-card-languages"
    >
      <VStack style={{ rowGap: m.blockGap * k }}>
        <Text
          allowFontScaling={false}
          className="font-semibold"
          testID="share-stats-languages-count"
          style={[textType(m.numeral, k, SHELL_METRICS.numeralLeading), ink('primary')]}
        >
          {String(stats.languageCount)}
        </Text>

        {segments.length > 0 ? (
          <VStack>
            <Text
              allowFontScaling={false}
              style={[textType(m.listTitle, k), { marginBottom: m.listTitleGap * k }, ink('muted')]}
            >
              {t('shareStats.card.topLanguagesTitle')}
            </Text>
            <ProportionBar segments={segments} k={k} testID="share-stats-languages-bar" />
          </VStack>
        ) : null}

        {lead.length > 0 ? (
          <VStack testID="share-stats-languages-list">
            {lead.map((language) => (
              <HStack
                key={language.languageCode}
                className="items-center justify-between"
                style={{ columnGap: 8 * k, marginTop: m.rowGap * k }}
              >
                {/* The name is resolved by lib/language-names.ts, which is
                    already localised into all 20 app locales and carries an
                    override table for the ones the CLDR pack gets wrong. No
                    new copy, and no per-locale language list to maintain. */}
                <Text
                  allowFontScaling={false}
                  style={[textType(m.rowText, k), { flex: 1 }, ink('primary')]}
                  numberOfLines={1}
                >
                  {/* Resolved against the SHELL's `locale` prop, which the
                      screen already threads for the date stamp, rather than
                      reaching back into i18n: one source for "what language is
                      this card written in" means the names and the date can
                      never disagree. Falls back to the uppercased code, which
                      is a real thing a reader can act on, never to a blank. */}
                  {getLocalizedLanguageName(language.languageCode, locale ?? 'en')
                    ?? language.languageCode.toUpperCase()}
                </Text>
                <Text
                  allowFontScaling={false}
                  style={[textType(m.rowPercent, k), { flexShrink: 0 }, ink('secondary')]}
                >
                  {`${Math.round((language.visitCount / Math.max(total, 1)) * 100)}%`}
                </Text>
              </HStack>
            ))}
          </VStack>
        ) : null}
      </VStack>
    </CardShell>
  );
});

// --- 4. RHYTHM -------------------------------------------------------------

export const RhythmCard = React.forwardRef<View, StatsCardProps>(function RhythmCard(
  { stats, pixelRatio, stampedAtMs, locale },
  ref,
) {
  const { t } = useTranslation();
  const k = useK(pixelRatio);
  const m = RHYTHM_METRICS;

  // Seven initials, Monday first, from ONE comma-separated key rather than
  // seven keys. Duplicates within a locale are expected and correct (en T/T
  // and S/S): position carries the meaning, not the letter.
  const weekdays = t('shareStats.card.rhythmWeekdays').split(',').map((d) => d.trim());

  return (
    <CardShell
      ref={ref}
      title={t('shareStats.card.rhythmTitle')}
      windowLine={t('shareStats.screenSubtitle')}
      privacyLine={t('shareStats.card.privacyLine')}
      pixelRatio={pixelRatio}
      stampedAtMs={stampedAtMs}
      locale={locale}
      testID="share-stats-card-rhythm"
    >
      <VStack style={{ rowGap: m.blockGap * k }}>
        <Figure
          value={String(stats.daysReadCount)}
          // "Days you READ something", never "days you opened Mera News".
          // There is no app-open record, no session row and no launch counter
          // anywhere in the schema, so "opened" would be a false claim AND
          // would invite someone to add session tracking to make it true.
          label={t('shareStats.card.daysReadLabel')}
          k={k}
          size={m.numeral}
          labelSize={m.numeralLabel}
          labelGap={m.numeralLabelGap}
          testID="share-stats-rhythm-days"
        />

        <HeatGrid
          days={stats.days}
          peak={peakDayCount(stats.days)}
          k={k}
          weekdayInitials={weekdays}
          legendLess={t('shareStats.card.heatLegendLess')}
          legendMore={t('shareStats.card.heatLegendMore')}
          testID="share-stats-rhythm-grid"
        />

        <Text
          allowFontScaling={false}
          testID="share-stats-rhythm-note"
          style={[textType(m.note, k), ink('muted')]}
        >
          {t('shareStats.card.heatNote')}
        </Text>
      </VStack>
    </CardShell>
  );
});

// --- 5. PACE ---------------------------------------------------------------

export const PaceCard = React.forwardRef<View, StatsCardProps>(function PaceCard(
  { stats, pixelRatio, stampedAtMs, locale },
  ref,
) {
  const { t } = useTranslation();
  const k = useK(pixelRatio);
  const m = PACE_METRICS;

  const averageHours = roundedAverageHours(stats.publishToRead);
  const { sampledArticles, totalArticles } = stats.publishToRead;

  return (
    <CardShell
      ref={ref}
      title={t('shareStats.card.paceTitle')}
      windowLine={t('shareStats.screenSubtitle')}
      privacyLine={t('shareStats.card.privacyLine')}
      pixelRatio={pixelRatio}
      stampedAtMs={stampedAtMs}
      locale={locale}
      testID="share-stats-card-pace"
    >
      <VStack style={{ rowGap: m.blockGap * k }}>
        <VStack>
          <Figure
            value={String(stats.articlesOpened)}
            label={t('shareStats.card.openedLabel')}
            k={k}
            size={m.numeral}
            labelSize={m.numeralLabel}
            labelGap={m.numeralLabelGap}
            testID="share-stats-pace-opened"
          />
          {/* The partial qualifier sits under its own figure, never in a
              collected footnote. "Articles opened" counts suggestion-card taps
              only, and saying so is the claim that keeps the figure true. */}
          <Text
            allowFontScaling={false}
            testID="share-stats-pace-opened-partial"
            style={[
              textType(SHELL_METRICS.qualifier, k),
              { marginTop: SHELL_METRICS.qualifierGap * k },
              ink('muted'),
            ]}
          >
            {t('shareStats.card.openedPartial')}
          </Text>
        </VStack>

        <VStack>
          <Text
            allowFontScaling={false}
            style={[
              textType(m.scaleTitle, k),
              { marginBottom: m.scaleTitleGap * k },
              ink('muted'),
            ]}
          >
            {t('shareStats.card.paceScaleTitle')}
          </Text>

          {averageHours === null ? (
            // Null is NOT zero: zero would read as "instant". The card says
            // there is not enough data instead, and draws no scale, because a
            // marker with nothing to mark is worse than no marker.
            <Text
              allowFontScaling={false}
              testID="share-stats-pace-unknown"
              style={[textType(SHELL_METRICS.qualifier, k), ink('secondary')]}
            >
              {t('shareStats.card.latencyUnknown')}
            </Text>
          ) : (
            <VStack>
              <Text
                allowFontScaling={false}
                className="font-semibold"
                testID="share-stats-pace-value"
                style={[
                  textType(m.scaleValue, k, SHELL_METRICS.numeralLeading),
                  { marginBottom: m.scaleValueGap * k },
                  ink('primary'),
                ]}
              >
                {t('shareStats.card.latencyValue', { count: averageHours })}
              </Text>
              <RuledScale
                value={averageHours}
                min={0}
                max={PACE_SCALE_MAX_HOURS}
                k={k}
                startLabel={t('shareStats.card.hoursShort', { n: 0 })}
                endLabel={t('shareStats.card.hoursShort', { n: PACE_SCALE_MAX_HOURS })}
                testID="share-stats-pace-scale"
              />
              {/* The denominator is inline and always present when there IS an
                  average. A bare average over the covered subset, presented as
                  the whole, is the specific claim this line refuses. */}
              <Text
                allowFontScaling={false}
                testID="share-stats-pace-coverage"
                style={[
                  textType(SHELL_METRICS.qualifier, k),
                  { marginTop: CHART_METRICS.scaleLabelTop * k },
                  ink('muted'),
                ]}
              >
                {t('shareStats.card.latencyCoverage', {
                  sampled: sampledArticles,
                  total: totalArticles,
                })}
              </Text>
            </VStack>
          )}
        </VStack>
      </VStack>
    </CardShell>
  );
});
