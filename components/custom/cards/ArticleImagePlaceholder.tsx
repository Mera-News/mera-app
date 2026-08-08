import MeraLogo from '@/components/custom/MeraLogo';
import React from 'react';
import { View } from 'react-native';

/**
 * ArticleImagePlaceholder — the shared "no image" fallback for every article
 * card surface. Replaced a photorealistic stock-photo asset (since deleted;
 * it was `assets/images/news_card_placeholder_image.jpg`, alt "News
 * placeholder") that QA found made unrelated stories (a Korean OpenAI story, an Indian
 * OpenAI story, an F1 standings story, a German data-deletion story) all
 * appear to share the same picture.
 *
 * Deliberately non-photographic: a translucent black wash plus a white
 * MeraLogo watermark, so it reads unambiguously as "no picture" rather than
 * as the article's own photo, and sits at home among the app's near-black
 * cards (dark mode only — `bg-background-0` is `rgb(18,17,19)`, see
 * `components/ui/gluestack-ui-provider/config.ts`).
 *
 * Was previously a warm off-white gradient with a dark ink glyph — the ground
 * has since moved to translucent black with a WHITE glyph (the design
 * decision behind this file, not this component's to relitigate). That
 * change happens to retire the react-native-svg gradient this file used to
 * draw: a FLAT translucent fill needs no gradient stops, and a flat color has
 * no percentage-sizing to get wrong, so the Android/iOS split this file used
 * to carry (RNSVG resolves `width="100%"/height="100%"` against the size at
 * FIRST layout and never re-measures — see the identical, still-live problem
 * in `components/custom/for-you/SectionGradientPanel.tsx`) is gone too: a
 * plain absolutely-filled View is correct on both platforms. The MeraLogo
 * glyph itself still uses `react-native-svg` internally, but at a fixed `size`
 * in dp, never a parent-relative percentage, so it never hit that bug.
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

// Translucent black wash, not an opaque fill. Card surfaces in this app are
// ALREADY near-black (`bg-background-0` dark = rgb(18,17,19)), so a flat
// opaque black rect would read as a hard hole punched in the list — mixing in
// GROUND_ALPHA lets that surface breathe through, the same "wash, not block"
// intent the old warm-paper gradient had, just monochrome now.
const GROUND_ALPHA = 0.32;

// The glyph ink is white (`#fff`) — MeraLogo's own default `color` (see
// MeraLogo.tsx), so this file no longer overrides it.
//
// The opacity is COMPUTED, not eyeballed — same requirement as the ground
// color it replaces (formerly `GLYPH_INK`/`GLYPH_OPACITY` = a dark ink at
// 0.58 over a warm off-white ground). That 0.58 does NOT carry over: it was
// solved for dark-ink-on-light-ground, and reusing it here (white-on-dark)
// would UNDER-shoot contrast, not over-shoot it, because opacity governs how
// much of the ink's own color reaches the eye against a ground that is now
// the same polarity as the "unlit" state — a wrong constant here is a
// regression that ships an inaccessible watermark, not a visual nit.
//
// Unlike the old ground (an OPAQUE gradient, `stopOpacity="1"` both stops —
// self-contained regardless of what was behind it), this ground is
// TRANSLUCENT, so what's behind it matters. Both card bases render this
// component with `CardGlassPlate` (`CARDS_USE_GLASS` in CardGlassPlate.tsx is
// hardcoded `true` — there is no live opaque path), which is `TranslucentPlate`
// from GlassSurface.tsx: a flat `rgba(255,255,255,0.07)` fill, NOT a real
// blur — so whatever renders behind the CARD shows through it, faintly
// lightened. Several of this component's own call sites (saved suggestions,
// story timeline, publication history, persona article list) mount
// `AbstractGradientBackdrop` behind the whole screen: an animated field of
// colored blobs (`PALETTE` in AbstractGradientBackdrop.tsx) peaking at
// `alpha 0.38` each, explicitly never additively stacked above that peak (see
// the "COMPLEMENTARY opacities" note there). That — glass tint over a blob at
// peak alpha, over the app's `bg-background-0` dark (`rgb(18,17,19)`) floor —
// is the true worst-case backdrop, and it is meaningfully LIGHTER than plain
// `bg-background-0`: an earlier draft of this comment assumed the opaque-card
// case was worst-case and asserted the glass path could never be lighter;
// that was wrong, unverified, and would have shipped a wrong contrast
// guarantee. The brightest palette entry against it is `sea green
// rgb(110,190,160)`:
//
//     blob   = rgb(110,190,160) composited at 0.38 over rgb(18,17,19)
//            ≈ rgb(53,83,73)
//     backdrop = rgb(255,255,255) composited at 0.07 (glass tint) over that
//            ≈ rgb(67,95,85)
//
// Compositing the translucent black wash over THAT backdrop
// (`backdrop*(1-GROUND_ALPHA)`, sRGB-space alpha blend, the same math `View`
// backgroundColor alpha does) gives the worst-case ground pixel color:
//
//     ground = rgb(67,95,85) * (1 - 0.32) ≈ rgb(46,64,58)
//
// Compositing white (`255,255,255`) over that ground at alpha a
// (`ground*(1-a) + 255*a` per channel) and running the WCAG contrast formula
// (relative luminance via the sRGB→linear transform, ratio =
// (L_light+0.05)/(L_dark+0.05)) against that SAME ground for a ≥3.5:1 floor
// (matching this file's original 3.5 target, itself above the 3:1 WCAG floor
// for non-text graphics):
//
//     a = 0.42 → 3.34:1   (short)
//     a = 0.43 → 3.42:1   (still short)
//     a = 0.44 → 3.51:1   ← clears 3.5 in the WORST case
//
// The same a = 0.44 clears far more comfortably everywhere else this
// component renders: ≈4.36:1 against a plain `bg-background-0` card (no
// gradient backdrop behind it) and ≈4.38:1 against `ArticleContextCard`'s
// hardcoded opaque `#1a1a1a` surface (`rgb(26,26,26)`, see
// components/custom/floating-chat/ArticleContextCard.tsx) — so the
// worst-case blob backdrop above is the one figure that actually binds this
// constant.
const GLYPH_OPACITY = 0.44;

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
    <View
      testID="placeholder-ground"
      pointerEvents="none"
      className="absolute inset-0 w-full h-full"
      style={{ backgroundColor: `rgba(0, 0, 0, ${GROUND_ALPHA})` }}
    />
    <View style={{ opacity: GLYPH_OPACITY }}>
      <MeraLogo size={size} animated={false} />
    </View>
  </View>
);

export const ArticleImagePlaceholder = React.memo(ArticleImagePlaceholderImpl);

export default ArticleImagePlaceholder;
