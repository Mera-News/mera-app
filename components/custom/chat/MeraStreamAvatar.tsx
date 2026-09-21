// The Mera mark beside a streaming assistant bubble, Messenger style.
//
// Reuses the app's own hexagon (`MeraLogo`) rather than drawing a second one,
// so the waiting state and the rest of the app cannot drift apart. No new
// dependency and no Lottie: the breathe is a Reanimated scale on a wrapper,
// and MeraLogo's own spotlight sweep is already gated internally.

import MeraLogo from '@/components/custom/MeraLogo';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

/** Gutter width. Fixed, so the bubble's left edge does not shift when the
 *  avatar appears at the start of a turn and goes at the end of it. */
export const AVATAR_SIZE = 22;
const BREATHE_MS = 1_800;

export interface MeraStreamAvatarProps {
  testID?: string;
}

export const MeraStreamAvatar: React.FC<MeraStreamAvatarProps> = ({
  testID = 'mera-stream-avatar',
}) => {
  const animationsActive = useAnimationsActive();
  const scale = useSharedValue(1);

  useEffect(() => {
    if (!animationsActive) {
      cancelAnimation(scale);
      scale.value = 1;
      return;
    }
    scale.value = withRepeat(
      withTiming(1.12, { duration: BREATHE_MS, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => cancelAnimation(scale);
  }, [animationsActive, scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <View style={styles.gutter} testID={testID}>
      <Animated.View style={style}>
        {/* Decorative: the bubble beside it already carries the live region,
            and two announcements for one wait is worse than none. */}
        <MeraLogo size={AVATAR_SIZE} animated={animationsActive} color="rgb(231, 138, 83)" />
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  gutter: {
    width: AVATAR_SIZE + 6,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 2,
  },
});

export default MeraStreamAvatar;
