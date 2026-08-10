import { CARDS_USE_GLASS, CardGlassPlate } from '@/components/custom/cards/CardGlassPlate';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import React from 'react';

export interface GlassPanelProps {
    /** `2xl` for a compact list header (FreeTierCard), `3xl` for a full-screen
     *  panel (NotSubscribedScreen). */
    readonly radius: '2xl' | '3xl';
    /** Passed straight through to `MeraLogo`. */
    readonly logoSize: number;
    /** Classes for the inner content Box — padding, mainly. */
    readonly contentClassName?: string;
    /** Classes for the OUTER (shadow-holding) Box — margins, width. */
    readonly className?: string;
    readonly testID?: string;
    readonly children: React.ReactNode;
}

const RADIUS_CLASS: Record<GlassPanelProps['radius'], string> = {
    '2xl': 'rounded-2xl',
    '3xl': 'rounded-3xl',
};

/**
 * The "glass card that opens with the Mera logo" chrome, shared by every
 * surface built on it — today `FreeTierCard` and the panel in
 * `NotSubscribedScreen`.
 *
 * TWO NESTED BOXES, and the nesting is load-bearing: RN drops a view's shadow
 * the instant that same view sets `overflow: hidden`, so the shadow has to
 * live on an OUTER, non-clipping Box while the rounded/clipped surface is the
 * INNER one. `CardGlassPlate` is a translucent fill (`TranslucentPlate`), NOT
 * a `GlassView` — no blur infra is introduced by using this.
 *
 * Lives in `cards/`, next to `CardGlassPlate`, rather than in `subscription/`:
 * this is card CHROME, not subscription logic. Callers own all copy and
 * actions via `children` — that keeps this component free of any locale key
 * of its own, and free of any opinion about what the card is FOR.
 */
const GlassPanel: React.FC<GlassPanelProps> = ({
    radius,
    logoSize,
    contentClassName,
    className,
    testID,
    children,
}) => {
    const roundedClass = RADIUS_CLASS[radius];

    return (
        <Box testID={testID} className={`${roundedClass} shadow-hard-2 ${className ?? ''}`}>
            <Box
                className={
                    CARDS_USE_GLASS
                        ? `${roundedClass} overflow-hidden border border-white/10`
                        : `${roundedClass} overflow-hidden bg-background-0 border border-white/10`
                }
            >
                <CardGlassPlate />
                <Box className={`w-full items-center ${contentClassName ?? ''}`}>
                    {/* `animated`: the same spotlight sweep every caller of this
                        panel already used before extraction — MeraLogo's own
                        prop, not a second animation. It self-gates on focus +
                        foreground (useAnimationsActive). */}
                    <Box className="items-center mb-4">
                        <MeraLogo size={logoSize} animated />
                    </Box>

                    {children}
                </Box>
            </Box>
        </Box>
    );
};

export default GlassPanel;
