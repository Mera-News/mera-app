import { MAX_FONT_SCALE, maxFontSizeMultiplierFor } from '../policy';
import { scaledTypeStyle } from '../TextScaleContext';
import {
  DEFAULT_TEXT_SCALE,
  MIN_FONT_SIZE_PX,
  TEXT_SCALE_LABEL_KEYS,
  TEXT_SCALE_STEPS,
  TYPE_SCALE,
  nearestTextScale,
} from '../scale';

describe('maxFontSizeMultiplierFor', () => {
  it('returns the tier cap when the user is at the default scale', () => {
    expect(maxFontSizeMultiplierFor('content', 1)).toBe(MAX_FONT_SCALE.content);
    expect(maxFontSizeMultiplierFor('chrome', 1)).toBe(MAX_FONT_SCALE.chrome);
    expect(maxFontSizeMultiplierFor('locked', 1)).toBe(MAX_FONT_SCALE.locked);
  });

  // The whole point of dividing: the in-app scale multiplies fontSize directly
  // and so is NOT subject to maxFontSizeMultiplier. If they did not compose,
  // choosing a bigger in-app size would reintroduce the clipping the cap
  // exists to prevent.
  it('keeps COMBINED growth at or below the tier cap', () => {
    for (const userScale of TEXT_SCALE_STEPS) {
      const cap = maxFontSizeMultiplierFor('content', userScale);
      expect(userScale * cap).toBeLessThanOrEqual(MAX_FONT_SCALE.content + 1e-9);
    }
  });

  it('never returns below 1 — that would shrink text below its own size', () => {
    expect(maxFontSizeMultiplierFor('locked', 4)).toBe(1);
    expect(maxFontSizeMultiplierFor('chrome', 10)).toBe(1);
  });

  it('falls back to the tier cap for a nonsense scale', () => {
    expect(maxFontSizeMultiplierFor('content', 0)).toBe(MAX_FONT_SCALE.content);
    expect(maxFontSizeMultiplierFor('content', NaN)).toBe(MAX_FONT_SCALE.content);
    expect(maxFontSizeMultiplierFor('content', -1)).toBe(MAX_FONT_SCALE.content);
  });

  it('orders the tiers content > chrome > locked', () => {
    expect(MAX_FONT_SCALE.content).toBeGreaterThan(MAX_FONT_SCALE.chrome);
    expect(MAX_FONT_SCALE.chrome).toBeGreaterThan(MAX_FONT_SCALE.locked);
    expect(MAX_FONT_SCALE.locked).toBeGreaterThan(1);
  });
});

describe('scaledTypeStyle', () => {
  // Load-bearing: at 1x no inline style is produced, so the default
  // configuration renders byte-identically to what shipped before the control
  // existed and the feature can only affect users who opted in.
  it('produces NOTHING at scale 1', () => {
    for (const token of Object.keys(TYPE_SCALE) as (keyof typeof TYPE_SCALE)[]) {
      expect(scaledTypeStyle(token, 1)).toBeUndefined();
    }
  });

  it('scales fontSize and lineHeight together', () => {
    const out = scaledTypeStyle('base', 1.5);
    expect(out).toEqual({ fontSize: 24, lineHeight: 36 });
  });

  it('floors fontSize at the platform minimum when scaling down', () => {
    const out = scaledTypeStyle('2xs', 0.9);
    expect(out!.fontSize).toBe(MIN_FONT_SIZE_PX);
  });

  it('keeps the leading ratio of a floored size instead of crushing it', () => {
    const out = scaledTypeStyle('2xs', 0.9)!;
    // Floored back to 11px, so the line height must come back to 11's own 16 —
    // not 0.9 * 16 = 14, which would be a tighter box around the same glyphs.
    expect(out.lineHeight).toBe(TYPE_SCALE['2xs'].lineHeight);
  });

  it('never returns a size below the floor at any offered step', () => {
    for (const step of TEXT_SCALE_STEPS) {
      for (const token of Object.keys(TYPE_SCALE) as (keyof typeof TYPE_SCALE)[]) {
        const out = scaledTypeStyle(token, step);
        if (out) expect(out.fontSize).toBeGreaterThanOrEqual(MIN_FONT_SIZE_PX);
      }
    }
  });
});

describe('text-scale steps', () => {
  it('includes 1 and defaults to it', () => {
    expect(TEXT_SCALE_STEPS).toContain(1);
    expect(DEFAULT_TEXT_SCALE).toBe(1);
  });

  it('is ascending and label-aligned', () => {
    expect(TEXT_SCALE_LABEL_KEYS).toHaveLength(TEXT_SCALE_STEPS.length);
    for (let i = 1; i < TEXT_SCALE_STEPS.length; i++) {
      expect(TEXT_SCALE_STEPS[i]).toBeGreaterThan(TEXT_SCALE_STEPS[i - 1]);
    }
  });
});

describe('nearestTextScale', () => {
  it('returns an exact step unchanged', () => {
    for (const step of TEXT_SCALE_STEPS) expect(nearestTextScale(step)).toBe(step);
  });

  // A stored value is untrusted: it is a string from the settings table, and a
  // step could be removed by a later release.
  it('snaps an off-grid value to the closest step', () => {
    expect(nearestTextScale(1.2)).toBe(1.15);
    expect(nearestTextScale(1.45)).toBe(1.5);
    expect(nearestTextScale(0.1)).toBe(0.9);
    expect(nearestTextScale(99)).toBe(1.5);
  });

  it('falls back to the default for a non-number', () => {
    expect(nearestTextScale(NaN)).toBe(DEFAULT_TEXT_SCALE);
    expect(nearestTextScale(Number('nope'))).toBe(DEFAULT_TEXT_SCALE);
  });
});
