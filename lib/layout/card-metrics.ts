/**
 * Card and parallax-header geometry that more than one file has to agree on.
 *
 * THE FRICTION (named, per the repo's own rule about not adding abstractions
 * without one): `HEADER_HEIGHT = 192` was declared twice — `SmoothScrollView`
 * and `SmoothFlatList` — and both carried the comment `(h-48 = 192px)`, tying
 * them to a Tailwind class on a THIRD file, `ArticleCardBase`, that neither
 * imports. Three places, one number, held together by a comment: changing the
 * hero height meant editing two constants and a utility class, and nothing
 * would have failed if you missed one — the parallax would simply have drifted
 * out of register with the image it parallaxes.
 *
 * This is one number with one name. The Tailwind side still cannot import it
 * (utility classes are build-time strings), so `HERO_IMAGE_CLASS` is exported
 * alongside it and `lib/layout/__tests__/card-metrics.test.ts` asserts the two
 * agree — which is the check the comment was standing in for.
 */

/** Hero image height on a full-size article card, in px. Tailwind `h-48`. */
export const CARD_HERO_HEIGHT = 192;

/** Tailwind class that must render `CARD_HERO_HEIGHT`. */
export const HERO_IMAGE_CLASS = 'h-48';

/**
 * Shortened band used when a card has no image.
 *
 * At full height the placeholder spent 192pt saying "there is no picture",
 * which dominated cards whose actual content is the headline and rationale.
 */
export const CARD_PLACEHOLDER_HEIGHT = 112;

/** Tailwind class that must render `CARD_PLACEHOLDER_HEIGHT`. */
export const PLACEHOLDER_IMAGE_CLASS = 'h-28';

/**
 * Default parallax header height for `SmoothScrollView` / `SmoothFlatList`.
 *
 * Equal to the hero by construction: the header IS the card hero when a card is
 * expanded into a detail screen, and the parallax interpolation is calibrated
 * against that height.
 */
export const PARALLAX_HEADER_HEIGHT = CARD_HERO_HEIGHT;
