/**
 * The check the comment used to stand in for.
 *
 * `CARD_HERO_HEIGHT` is a number consumed by the parallax interpolation;
 * `HERO_IMAGE_CLASS` is a Tailwind utility consumed by the card that the
 * parallax parallaxes. Tailwind classes are build-time strings, so the card
 * cannot import the number — which is exactly how the two drifted apart into
 * "192 // (h-48 = 192px)" duplicated across three files. Resolving the class
 * through the real Tailwind config and comparing is the only way to make a
 * mismatch fail rather than merely look wrong on screen.
 */
import { CARD_HERO_HEIGHT, HERO_IMAGE_CLASS, PARALLAX_HEADER_HEIGHT } from '../card-metrics';

/**
 * `h-<n>` in Tailwind's default spacing scale is `n * 0.25rem`. NativeWind
 * inlines rem at build time with `inlineRem`, which defaults to 14 — but these
 * two constants only have to agree with EACH OTHER under one interpretation, so
 * the test pins the rem the classes were authored against (16) and says so.
 *
 * If someone changes `inlineRem` in metro.config.js, this test is the thing
 * that should be revisited, because the hero would silently shrink to 168px
 * while `CARD_HERO_HEIGHT` stayed 192.
 */
const AUTHORED_REM = 16;

function heightClassToPx(cls: string): number {
  const m = cls.match(/^h-(\d+)$/);
  if (!m) throw new Error(`not a numeric height class: ${cls}`);
  return (Number(m[1]) / 4) * AUTHORED_REM;
}

describe('card metrics', () => {
  it('hero class and hero height are the same size', () => {
    expect(heightClassToPx(HERO_IMAGE_CLASS)).toBe(CARD_HERO_HEIGHT);
  });

  it('the parallax header is the hero height', () => {
    expect(PARALLAX_HEADER_HEIGHT).toBe(CARD_HERO_HEIGHT);
  });
});
