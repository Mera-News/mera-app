// A looping Lottie at a fixed size, held on frame 0 when nobody is looking,
// under Reduce Motion or in Lite mode. The empty-state heroes and the status
// card's 20pt stage scene draw through it. Same gate as IdleScene: a held
// frame, never an empty box (the asset gate keeps frame 0 meaningful).

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import LottieView from 'lottie-react-native';
import React from 'react';
import { View } from 'react-native';
import { useMotionAllowed } from '@/lib/motion-gate';

export interface LoopSceneProps {
  /** A `require()`d bodymovin file from one of the animation registries. */
  readonly source: unknown;
  readonly size: number;
  readonly testID?: string;
}

const LoopScene: React.FC<LoopSceneProps> = ({ source, size, testID }) => {
  const motion = useMotionAllowed();
  const active = useAnimationsActive();
  const playing = active && motion;
  return (
    <View
      testID={testID}
      style={{ width: size, height: size }}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <LottieView
        source={source as never}
        autoPlay={playing}
        progress={playing ? undefined : 0}
        loop
        renderMode="AUTOMATIC"
        resizeMode="contain"
        style={{ flex: 1 }}
      />
    </View>
  );
};

export default LoopScene;
