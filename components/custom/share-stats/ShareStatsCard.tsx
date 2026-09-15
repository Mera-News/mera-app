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
// ## What the card may and may not say
//
// Four figures, from `lib/stats/reading-stats.ts`, all computed on device from
// data the app already keeps to operate. The qualifiers are not decoration:
// each sits directly under its own figure rather than in one collected
// footnote, because a single footnote is the thing a screenshot crops off.
// Article titles never appear, under any setting. Publication names appear only
// when the reader turns them on.

import { SourceFlag } from '@/components/custom/SourceFlag';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
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
function type(size: number, k: number, leading = 1.45): TextStyle {
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
  const reserve = (SAFE_RESERVE_PX / EXPORT_HEIGHT) * host.height;

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
      style={{ width: host.width, height: host.height, backgroundColor: '#000000' }}
    >
      <Box
        className="flex-1 bg-black"
        style={{
          paddingTop: reserve,
          paddingBottom: reserve,
          paddingLeft: 28 * k,
          paddingRight: 28 * k,
        }}
      >
        <VStack className="flex-1 justify-between">
          {/* --- brand + window ------------------------------------------- */}
          <VStack>
            <HStack className="items-center" style={{ columnGap: 8 * k }}>
              <MeraLogo size={26 * k} />
              <Text
                allowFontScaling={false}
                className="text-typography-0 font-semibold"
                style={type(20, k, 1.2)}
              >
                Mera News
              </Text>
            </HStack>
            <Text
              allowFontScaling={false}
              className="text-gray-400"
              style={[type(13, k), { marginTop: 6 * k }]}
            >
              {t('shareStats.card.title')}
            </Text>
          </VStack>

          {/* --- the two count tiles -------------------------------------- */}
          <HStack style={{ columnGap: 12 * k }}>
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
              className="text-typography-0 font-semibold"
              style={type(averageHours === null ? 15 : 34, k, 1.2)}
            >
              {averageHours === null
                ? t('shareStats.card.latencyUnknown')
                : t('shareStats.card.latencyValue', { count: averageHours })}
            </Text>
            <Text
              allowFontScaling={false}
              className="text-typography-0"
              style={[type(11, k), { marginTop: 6 * k }]}
            >
              {t('shareStats.card.latencyLabel')}
            </Text>
            {/* The denominator is inline and always present when there IS an
                average. A bare average over the covered subset, presented as
                the whole, is the specific claim this line exists to refuse. */}
            {averageHours !== null && (
              <Text
                allowFontScaling={false}
                className="text-gray-400"
                style={[type(9.5, k), { marginTop: 4 * k }]}
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
              className="text-typography-0 font-semibold"
              style={type(34, k, 1.2)}
            >
              {String(stats.articlesOpened)}
            </Text>
            <Text
              allowFontScaling={false}
              className="text-typography-0"
              style={[type(11, k), { marginTop: 6 * k }]}
            >
              {t('shareStats.card.openedLabel')}
            </Text>
            <Text
              allowFontScaling={false}
              className="text-gray-400"
              style={[type(9.5, k), { marginTop: 4 * k }]}
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
                className="text-gray-400"
                style={type(10, k)}
              >
                {t('shareStats.card.topPublicationsTitle')}
              </Text>
              {stats.topPublications.map((publication) => (
                <HStack
                  key={`${publication.publicationName}::${publication.countryCode ?? ''}`}
                  className="items-center"
                  style={{ columnGap: 8 * k, marginTop: 6 * k }}
                >
                  <SourceFlag countryCode={publication.countryCode} size="lg" />
                  <Text
                    allowFontScaling={false}
                    className="text-typography-0"
                    style={type(12, k)}
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
              className="text-gray-400"
              style={type(9.5, k)}
            >
              {t('shareStats.card.privacyLine')}
            </Text>
            <Text
              allowFontScaling={false}
              className="text-typography-0"
              style={[type(11, k), { marginTop: 6 * k }]}
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
    style={{ padding: 14 * k }}
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
    style={{ padding: 14 * k }}
  >
    <Text
      allowFontScaling={false}
      className="text-typography-0 font-semibold"
      style={type(44, k, 1.15)}
    >
      {String(value)}
    </Text>
    <Text
      allowFontScaling={false}
      className="text-typography-0"
      style={[type(11, k), { marginTop: 4 * k }]}
    >
      {label}
    </Text>
  </Box>
);

export default ShareStatsCard;
