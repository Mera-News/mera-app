import MeraLogo from '@/components/custom/MeraLogo';
import React from 'react';
import { Platform, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

/**
 * ArticleImagePlaceholder — the shared "no image" fallback for every article
 * card surface. Replaced a photorealistic stock-photo asset (since deleted;
 * it was `assets/images/news_card_placeholder_image.jpg`, alt "News
 * placeholder") that QA found made unrelated stories (a Korean OpenAI story, an Indian
 * OpenAI story, an F1 standings story, a German data-deletion story) all
 * appear to share the same picture.
 *
 * Deliberately non-photographic: a warm off-white ground plus a dark MeraLogo
 * watermark, so it reads unambiguously as "no picture" rather than as the
 * article's own photo. Drawn with `react-native-svg` (already in the binary,
 * no `expo-linear-gradient` dependency) — same house pattern as
 * `components/custom/for-you/SectionGradientPanel.tsx`.
 *
 * `animated={false}` on MeraLogo is deliberate: this renders once per row in
 * long scrolling lists, and an animated SVG per card would be a performance
 * problem. Only the floating chat bubble / loading states use the animated
 * spotlight.
 *
 * Fills its parent absolutely — same fill behavior as the `<Image>` it
 * replaces. The parent Box owns sizing (fixed height for the full-size hero,
 * `self-stretch` for the compact column); this component never drives layout.
 *
 * Purely decorative: hidden from the accessibility tree (both platforms)
 * rather than carrying a misleading "News placeholder" label — it is not a
 * picture of the article, so it must not announce itself as one.
 */
const GRADIENT_ID = 'article-placeholder-gradient';

// Warm off-white ground, NOT pure white. #FFFFFF next to these near-black cards
// reads as a blown-out hole punched in the list; a warm paper tone sits with the
// app's warm accent (primary-400 is rgb(231,138,83)) and stays comfortable in a
// dark room. Kept as a gentle two-stop gradient rather than a flat fill so the
// panel still reads as deliberate artwork rather than a failed image load.
const GROUND_LIGHT = '#F5F1EA';
const GROUND_DEEP = '#E8E1D5';

// Warm near-black ink for the glyph.
//
// The opacity is COMPUTED, not eyeballed. At the original 0.45 the composited
// hexagon outline measured 2.7:1 against the ground — under the 3:1 WCAG floor
// for non-text graphics, and visibly faint across the wide full-size band at low
// screen brightness.
//
// Compositing `GLYPH_INK` over the ground at alpha a gives
// `ground*(1-a) + ink*a`; solving that for a ≥3.5:1 contrast ratio against BOTH
// gradient stops (the deeper stop is the worst case, so it sets the floor):
//
//     a = 0.55 → 3.37 light / 3.27 deep   (still short)
//     a = 0.57 → 3.56 light / 3.45 deep   (deep stop misses)
//     a = 0.58 → 3.66 light / 3.52 deep   ← both clear 3.5
//
// Kept as an alpha rather than a pre-multiplied hex so the glyph's own internal
// transparency still layers underneath (grid strokes 0.18, spotlight 0.30) — it
// stays a watermark, just a legible one.
const GLYPH_INK = '#2A2622';
const GLYPH_OPACITY = 0.58;

/** See the render branch below for why Android does not get the SVG gradient. */
const ANDROID_FLAT_GROUND = Platform.OS === 'android';

export interface ArticleImagePlaceholderProps {
  /** MeraLogo glyph size in dp. Default 40 — a modest watermark against both
   *  the 192px full-size hero and the narrower compact-card image column. */
  size?: number;
}

const ArticleImagePlaceholderImpl: React.FC<ArticleImagePlaceholderProps> = ({ size = 40 }) => (
  <View
    className="absolute inset-0 w-full h-full items-center justify-center overflow-hidden"
    accessible={false}
    accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
  >
    {ANDROID_FLAT_GROUND ? (
      // Android gets a flat ground instead of the SVG gradient.
      //
      // The Svg below sizes itself with `width="100%" height="100%"`, and on
      // Android RNSVG resolves those percentages against the size at FIRST
      // layout and never re-measures. The compact card's image column is
      // `w-1/4 self-stretch` inside a card with NO fixed minHeight (see
      // ArticleCompactCardBase), so the column's height is decided by the text
      // column beside it and keeps changing after that first pass — the title
      // wraps differently once fonts/translations settle, the publisher footer
      // arrives. The rect keeps its original height and leaves a hard
      // horizontal line partway down the column where the fill simply stops.
      // (Same RNSVG-on-Android family as SectionGradientPanel, which is flat
      // there for exactly this reason, and as the full-screen backdrop.)
      //
      // A plain absolutely-filled View has no measuring to get wrong. That
      // sizing bug is the reason for this gate. Secondary, and NOT verified
      // here: it also removes an `RNSVGSvgView` — a ViewGroup — from a
      // RECYCLING list row, so it may also help with the
      // `ViewGroup.dispatchGetDisplayList()` NPE, which was traced to the
      // full-screen backdrop and never to this component.
      //
      // GROUND_DEEP, not a midpoint: it is the stop the GLYPH_OPACITY
      // computation above certifies as the worst case (3.52:1 at a = 0.58), so
      // a flat fill of it provably keeps the watermark above the 3.5:1 floor
      // without redoing that maths. What is lost is the diagonal fade, which is
      // the acceptable half of the trade — today Android renders it broken.
      <View
        pointerEvents="none"
        className="absolute inset-0 w-full h-full"
        style={{ backgroundColor: GROUND_DEEP }}
      />
    ) : (
      <Svg width="100%" height="100%" style={{ position: 'absolute' }} preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={GROUND_LIGHT} stopOpacity="1" />
            <Stop offset="1" stopColor={GROUND_DEEP} stopOpacity="1" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${GRADIENT_ID})`} />
      </Svg>
    )}
    <View style={{ opacity: GLYPH_OPACITY }}>
      <MeraLogo size={size} animated={false} color={GLYPH_INK} />
    </View>
  </View>
);

export const ArticleImagePlaceholder = React.memo(ArticleImagePlaceholderImpl);

export default ArticleImagePlaceholder;
