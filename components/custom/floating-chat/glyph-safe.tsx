// Icon glyphs out of the accessibility tree (ux2 batch 26).
//
// On device an `@expo/vector-icons` icon IS a Text holding a private-use
// character. Captured on iOS: such a Text surfaces as its own StaticText
// whenever ANY ancestor is accessible, labelled or not, and the hidden props
// (DECORATIVE_ICON_A11Y) do nothing in that position. So an icon may only sit under plain,
// non-accessible Views, and must carry the hidden props itself. A labelled
// button that shows an icon is therefore a childless Pressable laid OVER a
// hidden visual, never a wrapper around it (`GlyphSafeButton`).
// Checked by exposedGlyphTexts (lib/__test-helpers__/icon-glyph-a11y.ts) and
// the source sweep in __tests__/chatIconsHidden.test.ts.

import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';

interface GlyphSafeButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  /** The box in its parent: margins, flex, alignSelf. */
  style?: StyleProp<ViewStyle>;
  /** What is drawn: padding, fill, border, the row layout. Sizes the box. */
  visualStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/** A labelled button whose visual sits beside the accessible element rather
 *  than inside it. The Pressable is childless and covers the visual exactly,
 *  so the touch target and the VoiceOver frame are the visual's box. Give it
 *  an `accessibilityLabel`: it has no text of its own to read. */
export const GlyphSafeButton: React.FC<GlyphSafeButtonProps> = ({
  style,
  visualStyle,
  children,
  accessibilityRole = 'button',
  ...press
}) => (
  <View style={style}>
    <View style={visualStyle} pointerEvents="none" {...DECORATIVE_ICON_A11Y}>
      {children}
    </View>
    <Pressable {...press} accessibilityRole={accessibilityRole} style={StyleSheet.absoluteFill} />
  </View>
);

/** The smallest touch frame iOS asks for. A NUMBER on purpose: NativeWind
 *  inlines rem at 14, so `w-11 h-11` renders 38.5pt, not 44. */
export const TOUCH_FRAME = 44;

interface GlyphSafeIconButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  /** The box in its parent: margins only. */
  style?: StyleProp<ViewStyle>;
  /** Drawn centred over the frame, touch-transparent and hidden. */
  children: React.ReactNode;
}

/** An icon-only button: a childless labelled Pressable of exactly
 *  TOUCH_FRAME points, with its disc and icon laid over it as a sibling. */
export const GlyphSafeIconButton: React.FC<GlyphSafeIconButtonProps> = ({
  style,
  children,
  accessibilityRole = 'button',
  ...press
}) => (
  <View style={style}>
    <Pressable {...press} accessibilityRole={accessibilityRole} style={frameStyles.frame} />
    <View style={frameStyles.overlay} pointerEvents="none" {...DECORATIVE_ICON_A11Y}>
      {children}
    </View>
  </View>
);

const frameStyles = StyleSheet.create({
  frame: { width: TOUCH_FRAME, height: TOUCH_FRAME },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
