import { sectionGradient } from '@/lib/section-color';
import React from 'react';
import { I18nManager, View, type StyleProp, type ViewStyle } from 'react-native';
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
    <View style={[{ borderRadius, overflow: 'hidden' }, style]}>
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
      {children}
    </View>
  );
};

const SectionGradientPanel = React.memo(SectionGradientPanelImpl);
SectionGradientPanel.displayName = 'SectionGradientPanel';

export default SectionGradientPanel;
