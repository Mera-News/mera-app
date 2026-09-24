import { CARDS_USE_GLASS, CardGlassPlate } from '@/components/custom/cards/CardGlassPlate';
import { Box } from '@/components/ui/box';
import React from 'react';

export interface FlatCardSurfaceProps {
    /** Outer spacing (margins) for the host's list; the surface itself is fixed. */
    className?: string;
    children: React.ReactNode;
}

/**
 * The Dashboard's floating card surface, in ONE place: the article cards'
 * `flat` treatment (ArticleCardBase) and the followed-story rows
 * (TrackedStoriesScreen) both draw it, so they cannot drift apart (owner:
 * "make these cards similar to the translucent cards like the article cards").
 *
 * The translucent plate sits over the page BACKDROP, so it takes no dark
 * over-content base (see GlassSurface's GLASS_OVER_CONTENT_FILL rule).
 *
 * Shadow lives on the outer, non-clipping Box: RN drops a view's shadow the
 * moment that same view also sets `overflow: hidden`, so the rounded, clipped
 * surface (border + plate + content) has to be a separate inner Box.
 */
const FlatCardSurface: React.FC<FlatCardSurfaceProps> = ({ className, children }) => (
    <Box className={`rounded-2xl shadow-hard-2${className ? ` ${className}` : ''}`}>
        <Box
            testID="card-surface"
            className={
                CARDS_USE_GLASS
                    ? // The opaque `bg-background-0` has to go, not just sit under
                      // the glass: a solid background over the plate cancels it.
                      'rounded-2xl overflow-hidden border border-white/10'
                    : 'rounded-2xl overflow-hidden bg-background-0 border border-white/10'
            }
        >
            <CardGlassPlate />
            {children}
        </Box>
    </Box>
);

export default FlatCardSurface;
