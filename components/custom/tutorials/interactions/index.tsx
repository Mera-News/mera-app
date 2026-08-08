import React from 'react';

import type { ChapterId, Interaction } from '@/lib/tutorials/types';
import BeforeAfterInteraction from './BeforeAfterInteraction';
import ChooseInteraction from './ChooseInteraction';
import SortInteraction from './SortInteraction';
import TapToRevealInteraction from './TapToRevealInteraction';

interface InteractionRendererProps {
    readonly chapterId: ChapterId;
    readonly slideId: string;
    readonly interaction: Interaction;
    /** Reported upward on every change; the player turns it into the Next gate. */
    readonly onUnlockedChange: (unlocked: boolean) => void;
}

/**
 * Pure dispatcher. ⚠️ CALLS NO HOOKS.
 *
 * `reactCompiler: true` — a single component that branched on
 * `interaction.kind` and also called `useState`/`useSharedValue` would compile
 * to conditional hooks. One component per kind, and this switch mounts exactly
 * one of them, keyed on the slide so switching slides resets interaction state
 * rather than carrying a previous slide's reveals across.
 */
const InteractionRenderer: React.FC<InteractionRendererProps> = ({
    chapterId,
    slideId,
    interaction,
    onUnlockedChange,
}) => {
    switch (interaction.kind) {
        case 'tap-to-reveal':
            return (
                <TapToRevealInteraction
                    chapterId={chapterId}
                    slideId={slideId}
                    targets={interaction.targets}
                    requiredReveals={interaction.requiredReveals}
                    onUnlockedChange={onUnlockedChange}
                />
            );
        case 'choose':
            return (
                <ChooseInteraction
                    chapterId={chapterId}
                    slideId={slideId}
                    options={interaction.options}
                    mustBeCorrect={interaction.mustBeCorrect}
                    onUnlockedChange={onUnlockedChange}
                />
            );
        case 'sort':
            return (
                <SortInteraction
                    chapterId={chapterId}
                    slideId={slideId}
                    cards={interaction.cards}
                    buckets={interaction.buckets}
                    onUnlockedChange={onUnlockedChange}
                />
            );
        case 'before-after':
            return (
                <BeforeAfterInteraction
                    chapterId={chapterId}
                    slideId={slideId}
                    requiredToggles={interaction.requiredToggles}
                    onUnlockedChange={onUnlockedChange}
                />
            );
        default:
            return null;
    }
};

export default InteractionRenderer;
