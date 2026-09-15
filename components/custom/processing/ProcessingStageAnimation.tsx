import LottieView from 'lottie-react-native';
import React from 'react';
import { View } from 'react-native';

import { processingAnimationFor } from './animation-registry';
import StageFallback from './StageFallback';
import { stageDef } from './processing-stages';
import { PROCESSING_SCENE_SIZE, type ProcessingStageId } from './types';

interface ProcessingStageAnimationProps {
    readonly stage: ProcessingStageId;
    /** Reduce Motion, or the app's own "Static background" setting. */
    readonly isStatic: boolean;
    /** Focused and foregrounded: whether anyone is actually looking. */
    readonly animationsActive: boolean;
}

/**
 * The square scene at the top of the processing card.
 *
 * Draws the stage's bodymovin file when `animation-registry.ts` has one, and
 * the stage's designed Reanimated fallback when it does not. Both are real
 * shipped states: commenting a registry line out is a supported configuration
 * at any count from zero to six, and `ProcessingArea.test.tsx` renders every
 * stage with the registry empty for exactly that reason.
 *
 * ## The two gates, and why they are different questions
 *
 *  - `isStatic` is the reader's standing PREFERENCE: OS Reduce Motion, or the
 *    app's "Static background", which already defaults ON below 6 GB of RAM.
 *    Answered with a single frozen frame, because someone who asked for less
 *    motion should get a still picture rather than an empty box.
 *  - `animationsActive` is whether anyone is LOOKING. It is
 *    `useIsFocusedSafe() && foregrounded`, so it is false only when the screen
 *    is blurred or the app is backgrounded.
 *
 * That second gate needs its reasoning written down, because
 * `use-is-focused-safe.ts`'s own header says it is "deliberately NOT used for
 * animations that convey liveness of an in-flight operation the user is waiting
 * on", and a processing area is precisely such an animation. The warning is
 * about gating on something NARROWER than this. On screen and waiting, this
 * predicate is true and the liveness signal keeps running; it goes false only
 * when nobody is there to form a "hung request" impression in the first place.
 *
 * The cost of not gating is real and measured elsewhere in this repo: tabs stay
 * mounted, processing can run for minutes, and a loop left running keeps
 * recomputing behind whatever the reader walked off to. The next person to read
 * that hook's header will otherwise assume this was written without it.
 *
 * `progress={0}` pins the frozen frame. Every piece in `assets/animations/` is
 * authored so frame 0 is the composition at rest.
 */
const ProcessingStageAnimation: React.FC<ProcessingStageAnimationProps> = ({
    stage,
    isStatic,
    animationsActive,
}) => {
    const source = processingAnimationFor(stage);
    const playing = !isStatic && animationsActive;

    if (!source) {
        return (
            <View testID={`processing-fallback-${stage}`}>
                <StageFallback kind={stageDef(stage).fallback} active={playing} />
            </View>
        );
    }

    return (
        <View
            testID={`processing-animation-${stage}`}
            style={{ width: PROCESSING_SCENE_SIZE, height: PROCESSING_SCENE_SIZE }}
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

export default ProcessingStageAnimation;
