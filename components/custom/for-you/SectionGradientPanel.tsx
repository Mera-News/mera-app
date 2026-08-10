import { sectionColorAtAlpha, sectionGradient } from '@/lib/section-color';
import React from 'react';
import { I18nManager, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

interface SectionGradientPanelProps {
  /** Fact id — keys the stable pastel gradient (see `sectionGradient`). */
  factId: string;
  /** Corner radius of the panel. 0 for edge-to-edge chrome (e.g. FactFeed
   *  back-header). Default 12. */
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/**
 * A rounded surface whose background is the fact's stable pastel gradient
 * (left-solid → transparent horizontal fade, composited over the near-black
 * app background). The gradient is drawn with `react-native-svg` (already in the
 * binary — see `FloatingMeraBubble`) rather than `expo-linear-gradient`, so the
 * dashboard redesign ships OTA with no new native dependency.
 *
 * The gradient direction flips for RTL so the solid ink always sits on the
 * text-leading edge.
 */
/** See the render branch below for why Android draws the fade as a CSS
 *  background instead of as SVG. */
const ANDROID_CSS_GRADIENT = Platform.OS === 'android';

const SectionGradientPanelImpl: React.FC<SectionGradientPanelProps> = ({
  factId,
  borderRadius = 12,
  style,
  children,
}) => {
  const spec = sectionGradient(factId);
  const gradId = `grad-${factId}`;
  // Left-to-right in LTR; flip the stops' x extents in RTL so the solid edge
  // hugs the leading (text) side.
  const x1 = I18nManager.isRTL ? '1' : '0';
  const x2 = I18nManager.isRTL ? '0' : '1';

  return (
    <View testID={`dashboard-section-${factId}`} style={[{ borderRadius, overflow: 'hidden' }, style]}>
      {ANDROID_CSS_GRADIENT ? (
        // Android draws the SAME fade as a CSS background instead of as SVG.
        //
        // The Svg below sizes itself with `width="100%" height="100%"`, and on
        // Android RNSVG resolves those percentages against the size at FIRST
        // layout and does not re-measure. This panel grows after that — cards
        // mount, images load — so the gradient rect kept its original height and
        // left a hard horizontal line partway down the section where the fill
        // simply stopped. That bug is what this branch exists for, and it is
        // STRUCTURALLY GONE here rather than worked around: a background
        // drawable is re-shaded against the view's CURRENT bounds on every draw,
        // so there is no "first layout" for a percentage to be stuck to.
        //
        // This replaces a flat single-colour tint that carried a compensatory
        // `× 0.5` on its opacity — half the colour everywhere, to stand in for a
        // fade that averages to about that. With the real fade restored, the
        // opacity is the real `startOpacity` again and Android matches iOS.
        //
        // Alpha is baked into the stops (`hsla`) because CSS has no
        // `stopOpacity`; the end stop is the SAME hue at alpha 0, never the
        // keyword `transparent`, which is `rgba(0,0,0,0)` and would drag the
        // falloff through grey.
        <View
          pointerEvents="none"
          style={
            {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              // `to right` / `to left` mirrors the SVG branch's x1/x2 flip, so
              // the solid ink stays on the text-leading edge under RTL.
              experimental_backgroundImage:
                `linear-gradient(to ${I18nManager.isRTL ? 'left' : 'right'}, ` +
                `${sectionColorAtAlpha(spec.hue, spec.startOpacity)} 0%, ` +
                `${sectionColorAtAlpha(spec.hue, spec.endOpacity)} 100%)`,
            } as unknown as ViewStyle
          }
        />
      ) : (
      <Svg
        width="100%"
        height="100%"
        preserveAspectRatio="none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        <Defs>
          <LinearGradient id={gradId} x1={x1} y1="0" x2={x2} y2="0">
            <Stop offset="0" stopColor={spec.base} stopOpacity={spec.startOpacity} />
            <Stop offset="1" stopColor={spec.base} stopOpacity={spec.endOpacity} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradId})`} />
      </Svg>
      )}
      {children}
    </View>
  );
};

const SectionGradientPanel = React.memo(SectionGradientPanelImpl);
SectionGradientPanel.displayName = 'SectionGradientPanel';

export default SectionGradientPanel;
