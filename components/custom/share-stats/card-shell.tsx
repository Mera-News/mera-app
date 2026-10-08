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
import { useCardInk } from '@/components/custom/share-stats/card-theme';
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

/** Sizes shared by all three cards. Per-card sizes live with their card. No
 *  text size anywhere on a card may fall below 9.5 (see `qualifier`). */
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
  /** 9.5 is the text floor: 28.5px at the 1080px export, where ~28px is the
   *  smallest a shared story image stays readable. */
  qualifier: 9.5,
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

export interface CardShellProps {
  /** "{Card} · last 30 days" or "Right now" alone for a one-figure image; a
   *  packed image is titled "Your last 30 days" and each figure carries its
   *  own label, Right now included (owner: like the Stats page). */
  title: string;
  privacyLine: string;
  pixelRatio: number;
  /**
   * Explicit host size in POINTS, for the ON-SCREEN path (the Preview pager).
   *
   * Omitted means the EXPORT path: the host is `hostSizeForScale(pixelRatio)`,
   * 360x640 at 3x, with the two 250px reserves drawn as padding so the captured
   * PNG carries them. Supplied means the card is shown rather than rasterised,
   * fitted to the content-box ratio, with no reserves (no social chrome on a
   * phone screen to keep clear of). The CONTENT is identical either way.
   */
  hostSize?: { width: number; height: number };
  /** With `hostSize`: draw the WHOLE 9:16 export frame at that size, reserves
   *  included, so a preview shows exactly what is shared. `hostSize` must then
   *  be 9:16. */
  fullFrame?: boolean;
  testID: string;
  children: React.ReactNode;
  /** Reports the height the figures may fill (between the title and the
   *  privacy line), in this host's points. The packing measure reads it. */
  onBodyLayout?: (height: number) => void;
}

const CardShell = React.forwardRef<View, CardShellProps>(function CardShell(
  { title, privacyLine, pixelRatio, hostSize, fullFrame, testID, children, onBodyLayout },
  ref,
) {
  const { palette, ink } = useCardInk();
  // Only a content-box preview drops the reserves; the export and a full-frame
  // preview draw them.
  const onScreen = hostSize !== undefined && !fullFrame;
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
    <View ref={ref} collapsable={false} testID={testID} style={{ width: host.width, height: host.height }}>
      {/* Dark: the app's own background, pinned (`frame={0}`, the seed alone
          drifts every 45 s) so two shares of the same stats are identical.
          Light: the light theme's base. Inside the captured host, so it reaches
          the PNG edge to edge including both reserves. */}
      {palette.base === null ? (
        <Box className="absolute inset-0 bg-background-0">
          <AbstractGradientBackdrop seed="mera-stats-card" frame={0} />
        </Box>
      ) : (
        <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: palette.base }} />
      )}

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
          <VStack className="flex-1">
            <HStack className="items-center" style={{ columnGap: 8 * k, marginTop: logoMargin }}>
              <MeraLogo size={m.logoSize * k} color={palette.primary} />
              <Text
                allowFontScaling={false}
                className="font-semibold"
                style={[type(m.wordmark, k, m.numeralLeading), ink('primary')]}
              >
                mera.news
              </Text>
            </HStack>
            <Text
              allowFontScaling={false}
              testID={`${testID}-window`}
              style={[type(m.title, k), { marginTop: m.titleGap * 3 * k }, ink('secondary')]}
            >
              {title}
            </Text>
            <View
              style={{ flex: 1, marginTop: m.titleGap * 3 * k }}
              onLayout={onBodyLayout ? (e) => onBodyLayout(e.nativeEvent.layout.height) : undefined}
            >
              {children}
            </View>
          </VStack>

          {/* Inside the safe band, never in the bottom reserve. */}
          <Text allowFontScaling={false} style={[type(m.qualifier, k), ink('muted')]}>
            {privacyLine}
          </Text>
        </VStack>
      </Box>
    </View>
  );
});

export default CardShell;
