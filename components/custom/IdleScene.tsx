import LottieView from 'lottie-react-native';
import React from 'react';
import { useReducedMotion } from 'react-native-reanimated';

import { gameAnimationFor } from '@/components/custom/game-ui/animation-registry';
import { PROCESSING_SCENE_SIZE } from '@/components/custom/processing/types';
import { Box } from '@/components/ui/box';
import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';

interface IdleSceneProps {
    /** Required, and deliberately not defaulted: two surfaces draw this and a
     *  shared id would let an assertion pass against the wrong one. */
    readonly testID: string;
    /** Defaults to the size FeedProcessingCard's stage scene uses. Override only
     *  with a reason, since matching that number is the point. */
    readonly size?: number;
}

/**
 * The calm idle loop, drawn by every empty state that is waiting rather than
 * reporting a problem.
 *
 * ## One component, because it has two homes
 *
 * `AllCaughtUpCard` (there is nothing more to read) and `FeedProcessingCard`'s
 * fallback branch (a first feed is still being built) both draw it. They were
 * briefly two copies of the same twelve lines, which is how the two drift: one
 * gains a gate the other does not, and the difference only shows on the devices
 * nobody tests.
 *
 * ## The size is not a style choice
 *
 * `PROCESSING_SCENE_SIZE` is what `ProcessingArea` draws its stage scene at, at
 * the same offset from the card top. These surfaces swap between each other as
 * a run starts and ends, so matching the number means the swap does not make
 * the artwork jump, and a jump there reads as the card breaking rather than as
 * work beginning. Imported from `processing/types.ts` rather than the hook file,
 * which drags `FeedSyncIndicator` and the WatermelonDB singleton in with it.
 *
 * ## Not playing is a held frame, never an empty box
 *
 * `staticGradient` defaults ON below 6 GB of RAM, so the frozen frame is the
 * NORMAL rendering on a large share of the fleet rather than a rare
 * accessibility path. `game-hud-idle` is authored with both its layers lit at
 * frame 0 for exactly this reason, and the asset gate enforces that.
 *
 * ## It owns the reanimated import on purpose
 *
 * `jest.setup.js` does not mock `react-native-reanimated`, and importing it
 * throws on the uninitialised worklets native module. Keeping that import in
 * ONE component means a consumer's test mocks this file rather than having to
 * learn the reanimated mock. Adding it directly to `FeedProcessingCard` is what
 * broke `status-cards.test.tsx`.
 */
const IdleScene: React.FC<IdleSceneProps> = ({ testID, size = PROCESSING_SCENE_SIZE }) => {
    const reduceMotion = useReducedMotion();
    const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
    const animationsActive = useAnimationsActive();
    const playing = animationsActive && !(reduceMotion || staticGradient);

    return (
        <Box testID={testID} style={{ width: size, height: size }}>
            <LottieView
                source={gameAnimationFor('game-hud-idle') as never}
                autoPlay={playing}
                progress={playing ? undefined : 0}
                loop
                renderMode="AUTOMATIC"
                resizeMode="contain"
                style={{ flex: 1 }}
            />
        </Box>
    );
};

export default IdleScene;
