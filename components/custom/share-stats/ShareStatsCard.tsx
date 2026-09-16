// ShareStatsCard — the 9:16 card that gets rasterised and handed to the share
// sheet. Dark only, like the rest of the app.
//
// ## The export size, and why the host is sized the way it is
//
// P0 measured this on a real simulator rather than trusting the option names.
// `captureRef`'s `width`/`height` are NOT output pixels: they are points, which
// the library then multiplies by the device's pixel ratio. Asking for
// 1080 x 1920 on a 3x device produced a 3240 x 5760 PNG. Asking for nothing at
// all, from a 360 x 640 host on the same device, produced exactly 1080 x 1920.
//
// So the host is laid out at `EXPORT / PixelRatio.get()` points and the capture
// asks for those same points, which lands on the export size on any device
// scale: 360 x 640 at 3x, 540 x 960 at 2x. Everything inside is authored on a
// fixed 360-wide grid and multiplied by `k`, so the design is written once and
// the device scale only changes how many points it occupies.
//
// There is no post-capture resize available to fall back on:
// `expo-image-manipulator` is not installed and this wave installs nothing.
//
// ## Never override fontSize without lineHeight here
//
// This cost a whole spike round. `components/ui/text` resolves a `lineHeight`
// from its size token and merges caller `style` AFTER it, so an inline
// `fontSize` wins while the token's small `lineHeight` survives. React Native
// then clips the glyph to that line box. A 96pt "42" under a 24pt line height
// rasterised as a short dash and an underline stroke: a horizontal slice through
// the digits. The same clipping ate the above-base matras off Devanagari at a
// perfectly ordinary 22pt.
//
// Hence `type()` below, which always emits both, with enough leading for
// above-base marks in Devanagari and Thai. Every text node on this card goes
// through it.
//
// `allowFontScaling={false}` is on every line for a related reason: this is a
// fixed-pixel raster, so OS Dynamic Type must not grow the copy past the edges
// of a card nobody can scroll.
//
// ## Every colour comes from `ink()`, never from a palette class
//
// This card shipped its nine primary text nodes as `text-typography-0` and drew
// them NEAR-BLACK. The Gluestack dark palette is an INVERSION of the light one,
// so `typography-0` is the DARK end of the ramp (23 23 23) and `typography-950`
// is the white end. The app mounts `mode="dark"`, so the card was always asking
// for the dark end, on screen and in the PNG alike.
//
// It is worth being precise about what was and was not the cause, because the
// capture is the natural suspect and is innocent: `react-native-view-shot`
// snapshots the existing layer tree, it does not re-render, so a capture cannot
// differ from the screen for a colour reason. The preview was black too. What
// hid it was a component test asserting a CLASS NAME, which passes whatever the
// class resolves to, because a class string carries no colour. Same shape as a
// per-string size budget that cannot see a layout overflow.
//
// So colour lives in `style` beside `type()`, from `card-theme.ts`, and
// `share-stats-card.test.tsx` reads this directory's source and fails on the
// token itself. See card-theme.ts for the scale.
//
// ## What the card may and may not say
//
// Four figures, from `lib/stats/reading-stats.ts`, all computed on device from
// data the app already keeps to operate. The qualifiers are not decoration:
// each sits directly under its own figure rather than in one collected
// footnote, because a single footnote is the thing a screenshot crops off.
// Article titles never appear, under any setting. Publication names appear only
// when the reader turns them on.

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { SourceFlag } from '@/components/custom/SourceFlag';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ink } from '@/components/custom/share-stats/card-theme';
import { roundedAverageHours, type ReadingStats } from '@/lib/stats/reading-stats';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { View, type TextStyle } from 'react-native';

/** The shipping export size. Not a preference. */
export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;

/** The grid every size below is authored on. Only `k` changes per device. */
const DESIGN_WIDTH = 360;

/**
 * Instagram draws its own chrome over both ends of a story. The plan's working
 * figure is 250 export pixels at each end; nothing readable may cross it.
 *
 * NOT verified against Instagram's current published guidance, and deliberately
 * left as the plan's stated figure rather than asserted as confirmed. The safe
 * zone is the one thing a simulator cannot sign off: it takes a real post.
 */
export const SAFE_RESERVE_PX = 250;

/**
 * Where the FIRST row of ink is allowed to start, in export pixels.
 *
 * Measured on a real 1080x1920 capture, the first ink row landed at 13.07% of
 * the height while the reserve ends at 13.02%, so the wordmark was grazing the
 * line by about 1.4 px. The reserve is the boundary, not a target to sit on:
 * the logo is an SVG whose glyph fills its box, so its ink starts exactly at
 * the padding edge with none of the leading that keeps a text run clear.
 *
 * 280 px is 14.58%, which clears the ruled 14.5% floor with a little room.
 * The BOTTOM is unchanged: last ink measured 16.72% from the bottom, well
 * inside its own reserve, so it needs no equivalent.
 */
export const TOP_INK_FLOOR_PX = 280;

/**
 * Every size the card lays out with, in design points on the 360-wide grid.
 *
 * Exported as ONE object because the height budget has to be checkable. Capture
 * 5 overflowed with the naming toggle ON and three publications: the footer was
 * clipped clean off the 1080x1920 PNG and the privacy line sat at 11.2% from
 * the bottom, inside the Instagram reserve. The per-string locale budget did
 * not catch it, and could not have: it measured how many LINES each string
 * wraps to, never the TOTAL HEIGHT of the stack. `share-stats-locale-budget`
 * now models that total off this object, so the card and its budget can never
 * disagree about what the card is made of.
 *
 * The sizes below are what makes the worst case fit: names ON, three rows, in
 * the longest locale. They are tighter than the first pass, which was sized by
 * eye against English with names OFF.
 */
export const CARD_METRICS = {
  outerPadding: 26,
  panelPadding: 11,
  tileGap: 10,
  /** Leading multiplier for label and qualifier text. Sized for Devanagari and
   *  Thai above-base marks, not for Latin. */
  textLeading: 1.4,
  /** Leading for numerals, which carry no above-base marks. */
  numeralLeading: 1.15,
  logoSize: 24,
  wordmark: 18,
  title: 12,
  titleGap: 5,
  tileNumeral: 38,
  tileLabel: 10,
  tileLabelGap: 3,
  panelValue: 29,
  panelValueUnknown: 13,
  panelLabel: 10,
  panelLabelGap: 5,
  qualifier: 8.5,
  qualifierGap: 2,
  topListTitle: 9,
  topRowText: 11,
  topRowGap: 4,
  footerGap: 4,
  footerDomain: 10,
} as const;

export interface ShareStatsCardProps {
  stats: ReadingStats;
  /** Off by default, everywhere. Publication names are revealing. */
  showPublicationNames: boolean;
  /** `PixelRatio.get()`. Injected rather than read here so the same component
   *  renders identically in a test and on a device. */
  pixelRatio: number;
}

/** Host size in POINTS for a given device scale. See the header. */
export function hostSizeForScale(pixelRatio: number): { width: number; height: number } {
  const scale = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return { width: EXPORT_WIDTH / scale, height: EXPORT_HEIGHT / scale };
}

/**
 * One text style. ALWAYS emits `lineHeight` beside `fontSize` — see the header
 * for what happens when it does not.
 *
 * The default 1.45 leading is sized for Devanagari and Thai above-base marks,
 * not for Latin, which would be comfortable much tighter. Numerals pass a
 * smaller ratio because they carry no above-base marks and a 1.45 line box
 * around a 44pt figure opens a visible hole in the layout.
 */
function type(size: number, k: number, leading: number = CARD_METRICS.textLeading): TextStyle {
  const fontSize = size * k;
  return { fontSize, lineHeight: Math.ceil(fontSize * leading) };
}

const ShareStatsCard = React.forwardRef<View, ShareStatsCardProps>(function ShareStatsCard(
  { stats, showPublicationNames, pixelRatio },
  ref,
) {
  const { t } = useTranslation();
  const host = hostSizeForScale(pixelRatio);
  const k = host.width / DESIGN_WIDTH;
  const bottomReserve = (SAFE_RESERVE_PX / EXPORT_HEIGHT) * host.height;
  const topInset = (TOP_INK_FLOOR_PX / EXPORT_HEIGHT) * host.height;

  const averageHours = roundedAverageHours(stats.publishToRead);
  const { sampledArticles, totalArticles } = stats.publishToRead;

  const showTopPublications = showPublicationNames && stats.topPublications.length > 0;

  return (
    // `collapsable={false}` keeps Android from flattening the host out of the
    // view hierarchy, which would leave captureRef nothing to snapshot.
    <View
      ref={ref}
      collapsable={false}
      testID="share-stats-card"
      style={{ width: host.width, height: host.height }}
    >
      {/* The card's background is the app's own, not a flat fill: the screens
          this card is about are painted by AbstractGradientBackdrop over
          `background-0`, and a share that looks like the app is the point.
          It is INSIDE the captured host, so it reaches the PNG edge to edge
          including both Instagram reserves.

          `frame={0}` is what makes a capture reproducible, and the seed alone
          would NOT have been enough: the seed fixes the colour SEQUENCE, while
          the shared, time-driven step picks the position in it, so a seeded
          backdrop still drifts every 45 seconds. Pinned, two shares of the same
          stats produce identical files.

          Contrast is unchanged by this: the blobs peak at alpha 0.38 over
          `#121113`, which is exactly what the app already puts white text and
          white-bordered panels over. */}
      <Box className="absolute inset-0 bg-background-0">
        <AbstractGradientBackdrop seed="mera-stats-card" frame={0} />
      </Box>

      <Box
        className="flex-1"
        style={{
          paddingTop: topInset,
          paddingBottom: bottomReserve,
          paddingLeft: CARD_METRICS.outerPadding * k,
          paddingRight: CARD_METRICS.outerPadding * k,
        }}
      >
        <VStack className="flex-1 justify-between">
          {/* --- brand + window ------------------------------------------- */}
          <VStack>
            <HStack className="items-center" style={{ columnGap: 8 * k }}>
              <MeraLogo size={CARD_METRICS.logoSize * k} />
              <Text
                allowFontScaling={false}
                className="font-semibold"
                style={[type(CARD_METRICS.wordmark, k, CARD_METRICS.numeralLeading), ink('primary')]}
              >
                Mera News
              </Text>
            </HStack>
            <Text
              allowFontScaling={false}
              style={[type(CARD_METRICS.title, k), { marginTop: CARD_METRICS.titleGap * k }, ink('muted')]}
            >
              {t('shareStats.card.title')}
            </Text>
          </VStack>

          {/* --- the two count tiles -------------------------------------- */}
          <HStack style={{ columnGap: CARD_METRICS.tileGap * k }}>
            <CountTile
              k={k}
              value={stats.publicationCount}
              label={t('shareStats.card.publicationsLabel')}
              testID="share-stats-card-publications"
            />
            <CountTile
              k={k}
              value={stats.countryCount}
              label={t('shareStats.card.countriesLabel')}
              testID="share-stats-card-countries"
            />
          </HStack>

          {/* --- publish-to-read latency ---------------------------------- */}
          <Panel k={k} testID="share-stats-card-latency">
            <Text
              allowFontScaling={false}
              className="font-semibold"
              style={[type(averageHours === null ? CARD_METRICS.panelValueUnknown : CARD_METRICS.panelValue, k, CARD_METRICS.numeralLeading), ink('primary')]}
            >
              {averageHours === null
                ? t('shareStats.card.latencyUnknown')
                : t('shareStats.card.latencyValue', { count: averageHours })}
            </Text>
            <Text
              allowFontScaling={false}
              style={[type(CARD_METRICS.panelLabel, k), { marginTop: CARD_METRICS.panelLabelGap * k }, ink('secondary')]}
            >
              {t('shareStats.card.latencyLabel')}
            </Text>
            {/* The denominator is inline and always present when there IS an
                average. A bare average over the covered subset, presented as
                the whole, is the specific claim this line exists to refuse. */}
            {averageHours !== null && (
              <Text
                allowFontScaling={false}
                style={[type(CARD_METRICS.qualifier, k), { marginTop: CARD_METRICS.qualifierGap * k }, ink('muted')]}
              >
                {t('shareStats.card.latencyCoverage', {
                  sampled: sampledArticles,
                  total: totalArticles,
                })}
              </Text>
            )}
          </Panel>

          {/* --- articles opened ------------------------------------------ */}
          <Panel k={k} testID="share-stats-card-opened">
            <Text
              allowFontScaling={false}
              className="font-semibold"
              style={[type(CARD_METRICS.panelValue, k, CARD_METRICS.numeralLeading), ink('primary')]}
            >
              {String(stats.articlesOpened)}
            </Text>
            <Text
              allowFontScaling={false}
              style={[type(CARD_METRICS.panelLabel, k), { marginTop: CARD_METRICS.panelLabelGap * k }, ink('secondary')]}
            >
              {t('shareStats.card.openedLabel')}
            </Text>
            <Text
              allowFontScaling={false}
              style={[type(CARD_METRICS.qualifier, k), { marginTop: CARD_METRICS.qualifierGap * k }, ink('muted')]}
            >
              {t('shareStats.card.openedPartial')}
            </Text>
          </Panel>

          {/* --- opt-in publication names --------------------------------
              A block that is ABSENT rather than empty when the toggle is off,
              so the card has two clean vertical arrangements instead of a hole
              where a list would have been. */}
          {showTopPublications ? (
            <VStack testID="share-stats-card-top-publications">
              <Text
                allowFontScaling={false}
                style={[type(CARD_METRICS.topListTitle, k), ink('muted')]}
              >
                {t('shareStats.card.topPublicationsTitle')}
              </Text>
              {stats.topPublications.map((publication) => (
                <HStack
                  key={`${publication.publicationName}::${publication.countryCode ?? ''}`}
                  className="items-center"
                  style={{ columnGap: 8 * k, marginTop: CARD_METRICS.topRowGap * k }}
                >
                  <SourceFlag countryCode={publication.countryCode} size="lg" />
                  <Text
                    allowFontScaling={false}
                    style={[type(CARD_METRICS.topRowText, k), ink('primary')]}
                    numberOfLines={1}
                  >
                    {publication.publicationName}
                  </Text>
                </HStack>
              ))}
            </VStack>
          ) : null}

          {/* --- footer ---------------------------------------------------
              Inside the safe band, never in the bottom reserve. A store badge
              belongs on this line; both stores publish clear-space and minimum
              size rules and forbid recolouring, neither of which the reserve
              can guarantee. The badge artwork is not in this repo yet, so the
              line carries the domain until it is. */}
          <VStack>
            <Text
              allowFontScaling={false}
              style={[type(CARD_METRICS.qualifier, k), ink('muted')]}
            >
              {t('shareStats.card.privacyLine')}
            </Text>
            <Text
              allowFontScaling={false}
              style={[type(CARD_METRICS.footerDomain, k), { marginTop: CARD_METRICS.footerGap * k }, ink('secondary')]}
            >
              mera.news
            </Text>
          </VStack>
        </VStack>
      </Box>
    </View>
  );
});

const Panel: React.FC<{ k: number; testID: string; children: React.ReactNode }> = ({
  k,
  testID,
  children,
}) => (
  <Box
    testID={testID}
    className="rounded-lg border border-white"
    style={{ padding: CARD_METRICS.panelPadding * k }}
  >
    {children}
  </Box>
);

const CountTile: React.FC<{
  k: number;
  value: number;
  label: string;
  testID: string;
}> = ({ k, value, label, testID }) => (
  <Box
    testID={testID}
    className="flex-1 rounded-lg border border-white"
    style={{ padding: CARD_METRICS.panelPadding * k }}
  >
    <Text
      allowFontScaling={false}
      className="font-semibold"
      style={[type(CARD_METRICS.tileNumeral, k, CARD_METRICS.numeralLeading), ink('primary')]}
    >
      {String(value)}
    </Text>
    <Text
      allowFontScaling={false}
      style={[type(CARD_METRICS.tileLabel, k), { marginTop: CARD_METRICS.tileLabelGap * k }, ink('secondary')]}
    >
      {label}
    </Text>
  </Box>
);

export default ShareStatsCard;
