import React from 'react';
import { View } from 'react-native';
import LottieView from 'lottie-react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { useAnimationsActive } from '@/lib/hooks/use-is-focused-safe';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';
import type { SceneVisual } from '@/lib/tutorials/types';
import ScenePlaceholder from './ScenePlaceholder';
import { SCENE_HEIGHT } from './theme';
import { animationSourceFor } from './animation-registry';

interface SceneViewProps {
    readonly visual: SceneVisual;
    /**
     * The slide's derived animation id, `animationIdFor(chapterId, slide.id)`.
     *
     * DERIVED and not declared: `lib/tutorials/chapters.ts` carries no
     * `animation` field on any slide and does not need one, so a hero is turned
     * on by putting its file on disk and uncommenting one registry line, with
     * no chapter edit at all. `visual.animation` still wins where a slide wants
     * an id that is not its own, which nothing does today.
     */
    readonly animationId?: string;
    /** Resolved copy for a `steps` placeholder. */
    readonly stepLabels?: readonly string[];
}

/**
 * The scene block at the top of a slide, and the ONE place the animation seam
 * lives.
 *
 * A slide draws its animation when `animation-registry.ts` has an uncommented
 * entry for its id, and its `ScenePlaceholder` otherwise. Both are shipped
 * visual layers and they coexist indefinitely: the placeholders are what ~53
 * non-hero slides look like and they are good, so this is a swap where an asset
 * exists, never a fallback for a missing one.
 *
 * The registry is the only file in the repo that may hold a tutorial animation
 * `require()`, because Metro resolves `require()` at BUNDLE time: an entry
 * pointing at a file that is not on disk is a build error no runtime guard can
 * catch.
 *
 * ## Why the loop is gated twice
 *
 * `autoPlay` is off under EITHER of two conditions and the two are different
 * questions.
 *
 *  - `isStatic` is the USER'S standing preference: OS Reduce Motion, or the
 *    app's own "Static background", which already defaults ON below 6 GB of
 *    RAM. That one is answered by rendering a single frozen frame, because a
 *    reader who asked for less motion should get a still picture rather than
 *    nothing.
 *  - `useAnimationsActive()` is whether anyone is LOOKING: it is false only
 *    when the screen is blurred or the app is backgrounded. Tabs and pushed
 *    routes stay mounted, so without it a hero keeps a native animation running
 *    behind whatever the reader walked off to instead.
 *
 * `progress={0}` pins the frozen frame. Every piece in `assets/animations/` is
 * authored so that frame 0 is the composition at rest, which is what makes a
 * single frame a legitimate still rather than an arbitrary slice.
 */
const SceneView: React.FC<SceneViewProps> = ({ visual, animationId, stepLabels }) => {
    const source = animationSourceFor(visual.animation ?? animationId);
    const reduceMotion = useReducedMotion();
    const staticGradient = useDisplayPrefsStore((s) => s.staticGradient);
    const active = useAnimationsActive();
    const isStatic = reduceMotion || staticGradient;

    if (source) {
        return (
            <View
                accessible
                accessibilityRole="image"
                testID="tutorial-scene-animation"
                style={{ height: SCENE_HEIGHT }}
            >
                <LottieView
                    source={source as never}
                    autoPlay={!isStatic && active}
                    progress={isStatic ? 0 : undefined}
                    loop={visual.loop !== false}
                    renderMode="AUTOMATIC"
                    resizeMode="contain"
                    style={{ flex: 1 }}
                />
            </View>
        );
    }

    return (
        <View accessible accessibilityRole="image">
            <ScenePlaceholder placeholder={visual.placeholder} stepLabels={stepLabels} />
        </View>
    );
};

export default SceneView;
