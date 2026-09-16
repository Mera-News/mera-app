// card-shell — everything the three stats cards have in common.
//
// Extracted rather than copied three times, because what lives here is reserve
// discipline that was measured on a real capture and must not be re-derived:
// the export size, the host sizing rule, both Instagram reserves, the top ink
// floor, the frame-pinned backdrop, and the footer. A second copy of any of
// those is a second chance to get them wrong.
//
// What does NOT live here is each card's own sizes. Every card carries its own
// metrics object and its own worst-case height budget, because one shared
// metrics object means a change made for the reach card silently overflows the
// pace card in a locale nobody rendered.
//
// ## The export size, and why the host is sized the way it is
//
// `captureRef`'s `width`/`height` are NOT output pixels: they are points, which
// the library multiplies by the device's pixel ratio. Asking for 1080 x 1920 on
// a 3x device produced a 3240 x 5760 PNG. So the host is laid out at
// `EXPORT / PixelRatio.get()` points and the capture asks for those same points,
// which lands on the export size at any device scale. Everything inside is
// authored on a fixed 360-wide grid and multiplied by `k`.
//
// There is no post-capture resize to fall back on: `expo-image-manipulator` is
// not installed.
//
// ## Never override fontSize without lineHeight
//
// `components/ui/text` resolves a `lineHeight` from its size token and merges
// caller `style` AFTER it, so an inline `fontSize` wins while the token's small
// `lineHeight` survives and React Native clips the glyph to that line box. A
// 96pt numeral rasterised as a horizontal slice through its own digits, and the
// same clipping ate the above-base matras off Devanagari at an ordinary 22pt.
// `type()` below always emits both. Every text node on every card goes through
// it.
//
// ## Colour comes from ink(), never from a palette class
//
// See `card-theme.ts`. `text-typography-0` is the DARK end of this app's ramp.

import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import MeraLogo from '@/components/custom/MeraLogo';
import { ink } from '@/components/custom/share-stats/card-theme';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import React from 'react';
import { View, type TextStyle } from 'react-native';

/** The shipping export size. Not a preference. */
export const EXPORT_WIDTH = 1080;
export const EXPORT_HEIGHT = 1920;

/** The grid every size is authored on. Only `k` changes per device. */
export const DESIGN_WIDTH = 360;
export const DESIGN_HEIGHT = 640;

/**
 * Instagram draws its own chrome over both ends of a story. Nothing readable
 * may cross it.
 *
 * NOT verified against Instagram's current published guidance, and deliberately
 * left as the plan's stated figure rather than asserted as confirmed. The safe
 * zone is the one thing a simulator cannot sign off: it takes a real post.
 */
export const SAFE_RESERVE_PX = 250;

/**
 * The content box, DERIVED. 1080 x 1420 at 250 clear top and bottom.
 *
 * One constant for the export size, one for the reserve, and the box computed
 * from them, so a change to either cannot leave the other stale.
 */
export const INK_BOX_HEIGHT_PX = EXPORT_HEIGHT - 2 * SAFE_RESERVE_PX;

/**
 * The logo's own top margin, INSIDE the ink box. Not a boundary.
 *
 * This number used to be folded into the top reserve as a 280px "ink floor",
 * and that conflated two different things. The RESERVE is where the social
 * chrome sits and nothing may cross it. This 30px is the leading an SVG
 * wordmark does not have: a glyph fills its box, so the logo's ink starts
 * exactly at the padding edge, and a first measured capture put the first ink
 * row at 13.07% against a 13.02% reserve, grazing it by about 1.4px.
 *
 * Separating them is what makes the budget honest. With the two folded
 * together the box measured 1390px while the stated reserve implied 1420, so
 * the budget was 10pt stricter than the rule it claimed to enforce and the
 * difference looked like free space. It was never free: it is this margin. The
 * card renders identically either way; only the arithmetic now says what it
 * means.
 */
export const LOGO_TOP_MARGIN_PX = 30;

/** Sizes shared by all three cards. Per-card sizes live with their card. */
export const SHELL_METRICS = {
  outerPadding: 26,
  /** Leading for label and qualifier text. Sized for Devanagari and Thai
   *  above-base marks, not for Latin. */
  textLeading: 1.4,
  /** Leading for numerals, which carry no above-base marks. */
  numeralLeading: 1.15,
  logoSize: 24,
  wordmark: 18,
  title: 13,
  titleGap: 5,
  windowLine: 9.5,
  windowGap: 2,
  /** The made-on date, top right. Same size and tone family as the window
   *  line, because it does the same job: it makes the card's claim checkable
   *  by whoever sees it later instead of leaving it floating. */
  stampDate: 9.5,
  qualifier: 8.5,
  qualifierGap: 2,
  footerGap: 4,
  footerDomain: 10,
} as const;

/** Host size in POINTS for a given device scale. EXPORT path only. */
export function hostSizeForScale(pixelRatio: number): { width: number; height: number } {
  const scale = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return { width: EXPORT_WIDTH / scale, height: EXPORT_HEIGHT / scale };
}

/**
 * The content box's aspect ratio, width over height. 1080 / 1420.
 *
 * This is the shape an ON-SCREEN card is fitted to. It is NOT the export FILE's
 * ratio (1080/1920): the file carries 250px of empty reserve at each end for
 * the social chrome to sit over, and reproducing those two blank bands on a
 * phone would waste a fifth of the height showing nothing. What the reader sees
 * on screen is the content box at true ratio; what they share is that same
 * content with the reserves added back.
 */
export const INK_BOX_ASPECT = EXPORT_WIDTH / INK_BOX_HEIGHT_PX;

/**
 * The on-screen card size that fits `available` while preserving the content
 * box's ratio.
 *
 * HEIGHT-BOUND by design. The page is nearly always taller-than-wide relative
 * to 1080/1420 once the header, the screen chrome, the dots, the pill and the
 * tab bar are taken out, so height is what actually runs out, and width follows
 * from the ratio. Where the page is wider than the ratio allows, the card is
 * narrower than the page and LETTERBOXES horizontally — space either side, which
 * is correct, rather than a stretched card or a cropped one.
 *
 * Returns zeroes for a degenerate box so a caller renders nothing instead of a
 * card with a negative dimension.
 */
export function fitCardToPage(available: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const w = Number.isFinite(available.width) ? available.width : 0;
  const h = Number.isFinite(available.height) ? available.height : 0;
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };

  const byHeight = { width: h * INK_BOX_ASPECT, height: h };
  if (byHeight.width <= w) return byHeight;
  // The page is SHORTER than the ratio wants, so width binds instead. Still no
  // crop and still no stretch: the card simply gets smaller.
  return { width: w, height: w / INK_BOX_ASPECT };
}

/** One text style. ALWAYS emits `lineHeight` beside `fontSize`. */
export function type(
  size: number,
  k: number,
  leading: number = SHELL_METRICS.textLeading,
): TextStyle {
  const fontSize = size * k;
  return { fontSize, lineHeight: Math.ceil(fontSize * leading) };
}

/**
 * The date the card was MADE, formatted by the platform in the reader's own
 * locale and timezone.
 *
 * No format string, no per-locale ordering table, no composed string: date
 * order is not universal and `toLocaleDateString` already knows all twenty.
 * Same approach the daily-cap copy takes for its reset time, and for the same
 * reason a UTC date is wrong there, the DEVICE timezone is what is used here.
 *
 * Falls back to the ISO date rather than throwing: an exotic locale tag on a
 * device with a thin ICU build can reject the options bag, and a card that
 * renders without a date is better than a card that does not render.
 */
export function formatStampDate(ms: number, locale?: string): string {
  try {
    return new Date(ms).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return new Date(ms).toLocaleDateString('en-CA');
  }
}

export interface CardShellProps {
  /** The card's own heading. First person, matching the existing card. */
  title: string;
  /** "Last 30 days" or "Right now". ONE window statement per card, never two. */
  windowLine: string;
  privacyLine: string;
  pixelRatio: number;
  /**
   * When the card was made, epoch ms. INJECTED rather than read from the clock
   * here, and on the share path it is stamped when the CAPTURE starts, not at
   * mount: a card left on screen across midnight must not go out carrying
   * yesterday.
   */
  stampedAtMs: number;
  /** BCP-47 tag for the date format. Undefined means the platform default. */
  locale?: string;
  /**
   * Explicit host size in POINTS, for the ON-SCREEN path.
   *
   * Omitted means the EXPORT path: the host is `hostSizeForScale(pixelRatio)`,
   * 360x640 at 3x, with the two 250px reserves drawn as padding so the captured
   * PNG carries them. Supplied means the card is being shown on a page rather
   * than rasterised, so it is fitted to the content-box ratio and the reserves
   * are not drawn — there is no social chrome on a phone screen to keep clear
   * of, and drawing them would waste a fifth of the height on blank bands and
   * make the on-screen card a differently proportioned preview of the file.
   *
   * Either way the CONTENT is identical and its budget is the same one:
   * `share-stats-locale-budget` measures the 1080x1420 box, which is exactly
   * what both paths lay the content into.
   */
  hostSize?: { width: number; height: number };
  testID: string;
  children: React.ReactNode;
}

const CardShell = React.forwardRef<View, CardShellProps>(function CardShell(
  { title, windowLine, privacyLine, pixelRatio, stampedAtMs, locale, hostSize, testID, children },
  ref,
) {
  const onScreen = hostSize !== undefined;
  const host = hostSize ?? hostSizeForScale(pixelRatio);
  const k = host.width / DESIGN_WIDTH;
  // On screen the host IS the content box, so there is no reserve to subtract.
  // On the export path the host is the whole 1080x1920 file and the reserve is
  // the padding that keeps ink out of the social chrome's way.
  const reserve = onScreen ? 0 : (SAFE_RESERVE_PX / EXPORT_HEIGHT) * host.height;
  const logoMargin = (LOGO_TOP_MARGIN_PX / INK_BOX_HEIGHT_PX) * (onScreen ? host.height : (INK_BOX_HEIGHT_PX / EXPORT_HEIGHT) * host.height);
  const m = SHELL_METRICS;

  return (
    // `collapsable={false}` keeps Android from flattening the host out of the
    // view hierarchy, which would leave captureRef nothing to snapshot.
    <View
      ref={ref}
      collapsable={false}
      testID={testID}
      style={{ width: host.width, height: host.height }}
    >
      {/* The app's own background, not a flat fill: a share that looks like the
          app is the point. INSIDE the captured host, so it reaches the PNG edge
          to edge including both reserves.

          `frame={0}` is what makes a capture reproducible, and the seed alone
          would NOT be enough: the seed fixes the colour SEQUENCE while a shared
          time-driven step picks the position in it, so a seeded-only backdrop
          drifts every 45 seconds. Pinned, two shares of the same stats produce
          identical files. */}
      <Box className="absolute inset-0 bg-background-0">
        <AbstractGradientBackdrop seed="mera-stats-card" frame={0} />
      </Box>

      <Box
        className="flex-1"
        style={{
          paddingTop: reserve,
          paddingBottom: reserve,
          paddingLeft: m.outerPadding * k,
          paddingRight: m.outerPadding * k,
        }}
      >
        <VStack className="flex-1 justify-between">
          <VStack>
            {/* Two columns. The brand-and-title column is `flex: 1` and the
                date column `flexShrink: 0`, so a long German title WRAPS
                rather than pushing the date off the card. `alignItems` is
                flex-start so the date sits on the wordmark's line whatever the
                title does below it. */}
            <HStack style={{ alignItems: 'flex-start', columnGap: 10 * k, marginTop: logoMargin }}>
              <VStack style={{ flex: 1 }}>
                <HStack className="items-center" style={{ columnGap: 8 * k }}>
                  <MeraLogo size={m.logoSize * k} />
                  <Text
                    allowFontScaling={false}
                    className="font-semibold"
                    style={[type(m.wordmark, k, m.numeralLeading), ink('primary')]}
                  >
                    Mera News
                  </Text>
                </HStack>
                <Text
                  allowFontScaling={false}
                  className="font-semibold"
                  style={[type(m.title, k), { marginTop: m.titleGap * k }, ink('primary')]}
                >
                  {title}
                </Text>
              </VStack>
              <Text
                allowFontScaling={false}
                testID={`${testID}-stamp`}
                numberOfLines={1}
                style={[
                  type(m.stampDate, k),
                  { flexShrink: 0, marginTop: (m.logoSize - m.stampDate * 1.4) * 0.5 * k },
                  ink('muted'),
                ]}
              >
                {formatStampDate(stampedAtMs, locale)}
              </Text>
            </HStack>
            {/* The window statement sits directly under the title, never in a
                collected footnote, because a footnote is what a screenshot
                crops off. Exactly one per card. */}
            <Text
              allowFontScaling={false}
              testID={`${testID}-window`}
              style={[type(m.windowLine, k), { marginTop: m.windowGap * k }, ink('muted')]}
            >
              {windowLine}
            </Text>
          </VStack>

          {children}

          {/* Inside the safe band, never in the bottom reserve. A store badge
              belongs on this line; both stores publish clear-space and minimum
              size rules and forbid recolouring, neither of which the reserve
              can guarantee. The artwork is not in this repo yet. */}
          <VStack>
            <Text
              allowFontScaling={false}
              style={[type(m.qualifier, k), ink('muted')]}
            >
              {privacyLine}
            </Text>
            <Text
              allowFontScaling={false}
              style={[type(m.footerDomain, k), { marginTop: m.footerGap * k }, ink('secondary')]}
            >
              mera.news
            </Text>
          </VStack>
        </VStack>
      </Box>
    </View>
  );
});

export default CardShell;
