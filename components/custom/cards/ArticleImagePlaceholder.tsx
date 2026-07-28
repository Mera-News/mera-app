import MeraLogo from '@/components/custom/MeraLogo';
import React from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

/**
 * ArticleImagePlaceholder — the shared "no image" fallback for every article
 * card surface. Replaced a photorealistic stock-photo asset (since deleted;
 * it was `assets/images/news_card_placeholder_image.jpg`, alt "News
 * placeholder") that QA found made unrelated stories (a Korean OpenAI story, an Indian
 * OpenAI story, an F1 standings story, a German data-deletion story) all
 * appear to share the same picture.
 *
 * Deliberately non-photographic: a neutral dark gradient built from the app's
 * own dark-mode surface ramp (`--color-background-50` → `--color-background-0`,
 * see `components/ui/gluestack-ui-provider/config.ts`) plus a faint MeraLogo
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
    <Svg width="100%" height="100%" style={{ position: 'absolute' }} preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
          {/* dark-mode --color-background-50 (rgb(34,34,34)) */}
          <Stop offset="0" stopColor="rgb(34, 34, 34)" stopOpacity="1" />
          {/* dark-mode --color-background-0 (rgb(18,17,19)) */}
          <Stop offset="1" stopColor="rgb(18, 17, 19)" stopOpacity="1" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${GRADIENT_ID})`} />
    </Svg>
    <View style={{ opacity: 0.12 }}>
      <MeraLogo size={size} animated={false} />
    </View>
  </View>
);

export const ArticleImagePlaceholder = React.memo(ArticleImagePlaceholderImpl);

export default ArticleImagePlaceholder;
