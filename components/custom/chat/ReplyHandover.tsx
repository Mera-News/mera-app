// The first-words handover: the streaming reply takes the wait row's slot.
//
// Rendered as `MessageContent`'s container (`as`), so the bubble keeps its own
// styles and the thread keeps one item: the deriver drops the typing item in
// the render that shows the first text, and a second list item would add
// height. The streaming item's facts arrive through `StreamingReplyContext`
// because `as` receives only the container props.
//
// Cloud, motion on, first time this reply is seen:
//   0 ms        the surface fades in (150 ms) behind the strip; the text is
//               already there, below the strip, where the phase words were.
//   0-350 ms    the strip plays `return`: the sealed letter comes back.
//   350-550 ms  the strip lifts out (fade, 4 pt up) and the text glides up.
// Motion off, on device, or a replay: no overlay, nothing waits. The text is
// never held back, and the bubble holds the wait row's height while it
// streams, so nothing outside the slot moves.

import { useMotionAllowed } from '@/lib/motion-gate';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import React, { createContext, forwardRef, useContext, useEffect, useState } from 'react';
import { StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import EncryptionStrip from './EncryptionStrip';
import { useWaitRowHeight } from './use-wait-row-height';

export interface StreamingReplyInfo {
  id: string;
  showWords: boolean;
  engine: 'cloud' | 'local';
  /** No live steps box this turn, so the reply takes the wait row's slot. */
  handover: boolean;
}

export const StreamingReplyContext = createContext<StreamingReplyInfo | null>(null);

const SURFACE_IN_MS = 150;
const RETURN_MS = 350;
const LIFT_MS = 200;
/** Where the first line sits under the strip: the phase words' offset. */
const GLIDE_FROM = 38;
const LIFT_BY = 4;
/** The wait row's width: the 272pt strip plus the bubble's 14pt insets. */
const ROW_WIDTH = 272 + 28;
/** What the thread's own insets leave on a narrow screen. */
const THREAD_INSET = 48;

// ponytail: grows by one short id per handover for the session; a FlatList
// recycle or a reopened chat must never replay one.
const played = new Set<string>();

interface StreamingBubbleProps {
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children?: React.ReactNode;
}

export const StreamingBubble = forwardRef<View, StreamingBubbleProps>(function StreamingBubble(
  { style, testID, children },
  ref,
) {
  const info = useContext(StreamingReplyContext);
  const motion = useMotionAllowed();
  const colors = useColors();
  const mode = useThemeMode();
  const { width } = useWindowDimensions();
  const rowHeight = useWaitRowHeight(info?.showWords ?? false, info?.engine ?? 'cloud');
  const [overlay, setOverlay] = useState(
    () => !!info && info.handover && info.engine === 'cloud' && motion && !played.has(info.id),
  );

  const surface = useSharedValue(overlay ? 0 : 1);
  const lift = useSharedValue(0);
  const glide = useSharedValue(overlay ? GLIDE_FROM : 0);

  useEffect(() => {
    if (!overlay || !info) return;
    played.add(info.id);
    surface.value = withTiming(1, { duration: SURFACE_IN_MS });
    lift.value = withDelay(RETURN_MS, withTiming(1, { duration: LIFT_MS }));
    glide.value = withDelay(RETURN_MS, withTiming(0, { duration: LIFT_MS }));
    const done = setTimeout(() => setOverlay(false), RETURN_MS + LIFT_MS);
    return () => clearTimeout(done);
    // Once per mount: the overlay never restarts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const surfaceStyle = useAnimatedStyle(() => ({ opacity: surface.value }));
  const liftStyle = useAnimatedStyle(() => ({
    opacity: 1 - lift.value,
    transform: [{ translateY: -LIFT_BY * lift.value }],
  }));
  const glideStyle = useAnimatedStyle(() => ({ transform: [{ translateY: glide.value }] }));

  // The bubble's own surface, drawn as a layer so it can fade without the
  // text. Same rule as chat-ai's bubbleSurface.
  const fill: ViewStyle =
    mode === 'light'
      ? { backgroundColor: colors.panel, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.panelBorder }
      : { backgroundColor: colors.surfaceRaised };

  return (
    <View
      ref={ref}
      testID={testID}
      style={[
        style,
        info ? { minHeight: rowHeight } : null,
        overlay ? [styles.overlaying, { minWidth: Math.min(ROW_WIDTH, width - THREAD_INSET) }] : null,
      ]}
    >
      {overlay && <Animated.View pointerEvents="none" style={[styles.fill, fill, surfaceStyle]} />}
      <Animated.View style={overlay ? glideStyle : undefined}>{children}</Animated.View>
      {overlay && (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.strip, liftStyle]}
        >
          <EncryptionStrip host="row" fixed="return" />
        </Animated.View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  // While the overlay plays, the surface is the fading layer and the bubble
  // holds the wait row's width, so the strip fits inside it.
  overlaying: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    shadowOpacity: 0,
    elevation: 0,
  },
  fill: { ...StyleSheet.absoluteFillObject, borderRadius: 16 },
  strip: { position: 'absolute', top: 8, left: 14, right: 14 },
});

export default StreamingBubble;
