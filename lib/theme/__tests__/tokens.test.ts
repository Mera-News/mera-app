import { rawTokens } from '@/components/ui/gluestack-ui-provider/config';

import { SEMANTIC } from '../semantic';
import { THEME_COLORS, tripleToRgb } from '../tokens';

describe('tripleToRgb', () => {
  it('converts a nativewind triple into a CSS colour', () => {
    expect(tripleToRgb('231 138 83')).toBe('rgb(231, 138, 83)');
  });

  it('tolerates padding', () => {
    expect(tripleToRgb('  30   30  36 ')).toBe('rgb(30, 30, 36)');
  });
});

describe('THEME_COLORS', () => {
  it('exposes one camelCase entry per token, in both schemes', () => {
    expect(Object.keys(THEME_COLORS.light)).toHaveLength(Object.keys(rawTokens.light).length);
    expect(Object.keys(THEME_COLORS.dark)).toHaveLength(Object.keys(rawTokens.dark).length);
  });

  it('camelCases word segments but leaves numeric stops alone', () => {
    expect(THEME_COLORS.dark.primary400).toBe('rgb(231, 138, 83)');
    expect(THEME_COLORS.light.backgroundMuted).toBe('rgb(243, 244, 246)');
  });

  it('is frozen, so a consumer cannot mutate the palette', () => {
    expect(Object.isFrozen(THEME_COLORS)).toBe(true);
    expect(Object.isFrozen(THEME_COLORS.dark)).toBe(true);
  });

  it('is the accessor colour-asserting tests should use instead of a hex literal', () => {
    // A literal like '#EDA77E' silently stops tracking the token it was copied
    // from. This is the replacement.
    expect(THEME_COLORS.dark.primary500).toBe('rgb(237, 167, 126)');
  });
});

describe('SEMANTIC', () => {
  it('defines the same roles in both schemes', () => {
    expect(Object.keys(SEMANTIC.light).sort()).toEqual(Object.keys(SEMANTIC.dark).sort());
  });

  it('returns a stable frozen reference per scheme, safe in a dep array', () => {
    expect(SEMANTIC.light).toBe(SEMANTIC.light);
    expect(Object.isFrozen(SEMANTIC.light)).toBe(true);
  });

  it('every role resolves to a real rgb() string', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const [role, value] of Object.entries(SEMANTIC[scheme])) {
        expect(`${scheme}.${role}=${value}`).toMatch(/=rgb\(\d+, \d+, \d+\)$/);
      }
    }
  });

  it('uses a darker accent for TEXT than for the accent fill in light mode', () => {
    // primary-500 is 2.32:1 on Parchment. accentText must not be the fill.
    expect(SEMANTIC.light.accentText).not.toBe(SEMANTIC.light.accent);
  });

  it('puts Shadow Grey, not white, on an accent fill in light mode', () => {
    expect(SEMANTIC.light.onAccent).toBe(THEME_COLORS.light.typography950);
  });
});
