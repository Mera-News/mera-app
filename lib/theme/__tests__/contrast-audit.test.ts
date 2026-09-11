import {
  AA_NON_TEXT,
  AA_TEXT,
  KNOWN_FAILING_PAIRS,
  LEGACY_ALIAS_LIGHT,
  LIGHT_BACKDROPS,
  LIGHT_TEXT_TOKENS,
  contrastRatio,
  isInLabelDeadBand,
  relativeLuminance,
  worstOnLightBackdrops,
  type Rgb,
} from '../contrast-audit';

describe('WCAG arithmetic', () => {
  it('reproduces the reference extremes', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5);
  });

  it('is order-independent', () => {
    const a: Rgb = [231, 138, 83];
    const b: Rgb = [244, 243, 238];
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });

  it('puts Parchment where the spec says it is', () => {
    expect(relativeLuminance([244, 243, 238])).toBeCloseTo(0.895073, 5);
  });
});

describe('every text-bearing light token clears AA on ALL FOUR backdrops', () => {
  // Parchment alone is not enough: a raised card is lighter and a recessed well
  // is darker, so the worst case is never the one a single-backdrop check sees.
  it('has four backdrops', () => {
    expect(Object.keys(LIGHT_BACKDROPS)).toHaveLength(4);
  });

  it.each(Object.entries(LIGHT_TEXT_TOKENS))('%s clears 4.5:1', (_name, rgb) => {
    expect(worstOnLightBackdrops(rgb)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it.each(Object.entries(LEGACY_ALIAS_LIGHT).filter(([, v]) => v.role === 'text'))(
    'legacy alias %s clears 4.5:1',
    (_name, entry) => {
      expect(worstOnLightBackdrops(entry.rgb)).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it('gray-600 is the one that needed darkening, and the spec value would fail', () => {
    // Regression pin: 112 109 105 is 4.63 on Parchment and reads fine there,
    // but 4.35 on the recessed surface. This is the whole reason the audit
    // takes four backdrops instead of one.
    expect(worstOnLightBackdrops([112, 109, 105])).toBeLessThan(AA_TEXT);
    expect(worstOnLightBackdrops(LEGACY_ALIAS_LIGHT['gray-600'].rgb)).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });
});

describe('surface aliases invert, deliberately', () => {
  it('gray-900 is RAISED, lighter than the page', () => {
    expect(relativeLuminance(LEGACY_ALIAS_LIGHT['gray-900'].rgb)).toBeGreaterThan(
      relativeLuminance(LIGHT_BACKDROPS.parchment),
    );
  });

  it('gray-950 is RECESSED, darker than the page', () => {
    expect(relativeLuminance(LEGACY_ALIAS_LIGHT['gray-950'].rgb)).toBeLessThan(
      relativeLuminance(LIGHT_BACKDROPS.parchment),
    );
  });

  it('gray-800 ends up darker than gray-900, reversing Tailwind intuition', () => {
    expect(relativeLuminance(LEGACY_ALIAS_LIGHT['gray-800'].rgb)).toBeLessThan(
      relativeLuminance(LEGACY_ALIAS_LIGHT['gray-900'].rgb),
    );
  });
});

describe('decorative hairlines are NOT forced to 3:1', () => {
  // Forcing them would turn light mode into a grid of hard grey lines across
  // ~113 sites. WCAG 1.4.11 needs 3:1 only where a border is the SOLE means of
  // identifying a control; those migrate to border-outline-200 individually.
  it.each(['gray-700', 'gray-800'])('%s stays subtle', (name) => {
    expect(contrastRatio(LEGACY_ALIAS_LIGHT[name].rgb, LIGHT_BACKDROPS.parchment)).toBeLessThan(
      AA_NON_TEXT,
    );
  });
});

describe('known failing pairs stay failing', () => {
  it.each(KNOWN_FAILING_PAIRS)('$why', ({ fg, bg }) => {
    expect(contrastRatio(fg, bg)).toBeLessThan(AA_TEXT);
  });
});

describe('label dead band', () => {
  it('catches primary-600, which is why it may not bear text', () => {
    expect(isInLabelDeadBand([191, 101, 58])).toBe(true);
  });

  it('does not catch the accent fill or the pressed state', () => {
    expect(isInLabelDeadBand([231, 138, 83])).toBe(false);
    expect(isInLabelDeadBand([235, 160, 116])).toBe(false);
  });
});
