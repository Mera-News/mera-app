import React from 'react';
import { View } from 'react-native';

import type { SceneVisual } from '@/lib/tutorials/types';
import ScenePlaceholder from './ScenePlaceholder';
import { animationSourceFor } from './animation-registry';

interface SceneViewProps {
    readonly visual: SceneVisual;
    /** Resolved copy for a `steps` placeholder. */
    readonly stepLabels?: readonly string[];
}

/**
 * The scene block at the top of a slide, and the ONE place the animation seam
 * lives.
 *
 * The registry lookup below is LIVE. It resolves to `undefined` for every id
 * today because `animation-registry.ts` ships with every entry commented out —
 * this wave carries no animation runtime, which is exactly why the module is
 * OTA-able. So the placeholder always wins, and that is the shipped design, not
 * a fallback.
 *
 * ── Turning animations on later (P6) ────────────────────────────────────────
 * Uncomment the block below and its import, uncomment the matching entries in
 * `animation-registry.ts`, and re-cut the binary. Nothing else changes at any N
 * from 0 to 65 slides.
 *
 *   import LottieView from 'lottie-react-native';
 *   …
 *   if (source) {
 *     return (
 *       <View style={{ height: SCENE_HEIGHT }}>
 *         <LottieView
 *           source={source as never}
 *           autoPlay
 *           loop={visual.loop !== false}
 *           resizeMode="contain"
 *           style={{ flex: 1 }}
 *         />
 *       </View>
 *     );
 *   }
 *
 * Note this must stay a COMMENT until the package is installed: Metro resolves
 * `require`/`import` at BUNDLE time, so an uncommented import of a package that
 * is not in `package.json` is a build error no runtime guard can catch. That is
 * the trap `animation-registry.ts` exists to make unrepeatable, and
 * `lib/tutorials/__tests__/chapters.test.ts` asserts it mechanically.
 */
const SceneView: React.FC<SceneViewProps> = ({ visual, stepLabels }) => {
    // Live seam. Always `undefined` today; kept wired so P6 is a one-file change
    // rather than a re-plumb, and so a stray registry entry can never silently
    // do nothing.
    const source = animationSourceFor(visual.animation);
    void source;

    return (
        <View accessible accessibilityRole="image">
            <ScenePlaceholder placeholder={visual.placeholder} stepLabels={stepLabels} />
        </View>
    );
};

export default SceneView;
