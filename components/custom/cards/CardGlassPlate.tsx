import { GLASS_EDGE, TranslucentPlate } from '@/components/custom/GlassSurface';

/**
 * The article cards' background plate.
 *
 * ## Why cards are NOT real glass
 *
 * They were, briefly, and it was a mistake worth recording so nobody
 * "restores" it:
 *
 * 1. **Cost.** A `GlassView` is a `UIVisualEffectView`, and a blur re-samples
 *    its backdrop every frame that backdrop changes. The page backdrop animates
 *    continuously, so every glass card recomputed a blur every frame even while
 *    the user sat still — and a feed shows ~10 cards at once. It measurably
 *    slowed the app.
 * 2. **It defeated its own purpose.** Frosted glass is not transparent. Anything
 *    layered on a glass card (the reason box, the fact chips) showed the card's
 *    frost rather than the gradient behind the page, so nested translucency
 *    simply stopped working.
 *
 * Real glass is now reserved for CHROME — headers, the scroll FAB, the status
 * panel, the tab bar: few, mostly static surfaces. Content surfaces that exist
 * in quantity use `TranslucentPlate`, a plain translucent fill. Over a colourful
 * gradient the two are nearly indistinguishable, because a blur has little
 * high-frequency detail to diffuse there.
 *
 * See `components/custom/GlassSurface.tsx` for both primitives.
 */

/**
 * Always true now. It used to gate on iOS 26 because a real `GlassView` paints
 * nothing elsewhere; a translucent fill is just a background colour, so it works
 * on every platform and the cards no longer need an opaque fallback branch.
 * Kept as a named constant because both card bases still read it to decide
 * whether to drop their opaque background.
 */
export const CARDS_USE_GLASS = true;

/** Hairline edge for a card. The full-size card had no border of its own — its
 *  `bg-background-0` tone WAS the boundary — so on a translucent surface it
 *  needs one or it has no defined edge against the page. */
export const GLASS_CARD_EDGE = GLASS_EDGE;

/** Absolute-fill translucent background for a card. */
export const CardGlassPlate = TranslucentPlate;

export default CardGlassPlate;
