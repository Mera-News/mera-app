import { GLASS_AVAILABLE, GLASS_EDGE, GlassPlate } from '@/components/custom/GlassSurface';

/**
 * The article cards' view of the shared glass primitives.
 *
 * This file is deliberately a thin alias over `components/custom/GlassSurface`
 * rather than its own implementation: glass started on the cards and then spread
 * to headers and list rows, and two copies of the tint/edge tuning would drift
 * the first time either was adjusted. The card-flavoured names are kept because
 * the two card bases read better with them, and because `GLASS_CARD_EDGE`
 * documents a card-specific reason for existing (see below).
 *
 * Everything worth knowing — the iOS 26+ availability gate, why an opaque
 * background must be REMOVED rather than layered under the glass, and the
 * unpadded-parent requirement — is documented in `GlassSurface`.
 */

/** True only where glass actually paints — iOS 26+. Cards must branch on this
 *  and keep their old opaque chrome for the false case. */
export const CARDS_USE_GLASS = GLASS_AVAILABLE;

/** Hairline edge for a glass card. The full-size card had no border of its own
 *  — its `bg-background-0` tone WAS the boundary — so under glass it needs one
 *  or it has no defined edge against the page. */
export const GLASS_CARD_EDGE = GLASS_EDGE;

/** Absolute-fill glass background for a card. Renders nothing where glass is
 *  unavailable, so it is safe to mount unconditionally. */
export const CardGlassPlate = GlassPlate;

export default CardGlassPlate;
