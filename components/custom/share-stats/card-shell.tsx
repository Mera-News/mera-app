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
 * Where the FIRST row of ink may start, in export pixels.
 *
 * Measured on a real 1080x1920 capture the first ink row landed at 13.07% while
 * the reserve ends at 13.02%, grazing it by about 1.4px. The reserve is a
 * boundary, not a target: an SVG glyph fills its box, so the logo's ink starts
 * exactly at the padding edge with none of the leading that keeps a text run
 * clear. 280px is 14.58%.
 */
export const TOP_INK_FLOOR_PX = 280;

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

/** Host size in POINTS for a given device scale. */
export function hostSizeForScale(pixelRatio: number): { width: number; height: number } {
  const scale = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return { width: EXPORT_WIDTH / scale, height: EXPORT_HEIGHT / scale };
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
  testID: string;
  children: React.ReactNode;
}

const CardShell = React.forwardRef<View, CardShellProps>(function CardShell(
  { title, windowLine, privacyLine, pixelRatio, stampedAtMs, locale, testID, children },
  ref,
) {
  const host = hostSizeForScale(pixelRatio);
  const k = host.width / DESIGN_WIDTH;
  const bottomReserve = (SAFE_RESERVE_PX / EXPORT_HEIGHT) * host.height;
  const topInset = (TOP_INK_FLOOR_PX / EXPORT_HEIGHT) * host.height;
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
          paddingTop: topInset,
          paddingBottom: bottomReserve,
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
            <HStack style={{ alignItems: 'flex-start', columnGap: 10 * k }}>
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
