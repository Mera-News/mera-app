// P3's contract, in three parts that can each fail independently.
//
// 1. The dark alias values are the EXACT Tailwind hexes the class names
//    resolved to before the flip. That is what makes the alias provably a
//    no-op in dark, and it is the only reason a 580-occurrence change can ship
//    without a pixel diff.
// 2. The light values are the ones the four-backdrop audit produced. The audit
//    is the single source; this binds the config to it so the two cannot drift.
// 3. The root floor in global.css matches the dark block, because nativewind's
//    rootVariables is what an aliased class falls back to outside the provider.

import fs from 'node:fs';
import path from 'node:path';

import { rawTokens } from '@/components/ui/gluestack-ui-provider/config';

import { LEGACY_ALIAS_LIGHT, worstOnLightBackdrops, AA_TEXT } from '../contrast-audit';

/** Tailwind 3.4.18 defaults, read off the package at the time of the flip. */
const TAILWIND_DEFAULTS: Record<string, string> = {
  white: '255 255 255',
  black: '0 0 0',
  'gray-50': '249 250 251',
  'gray-100': '243 244 246',
  'gray-200': '229 231 235',
  'gray-300': '209 213 219',
  'gray-400': '156 163 175',
  'gray-500': '107 114 128',
  'gray-600': '75 85 99',
  'gray-700': '55 65 81',
  'gray-800': '31 41 55',
  'gray-900': '17 24 39',
  'gray-950': '3 7 18',
};

describe('dark is provably unchanged by the alias flip', () => {
  it.each(Object.entries(TAILWIND_DEFAULTS))(
    'legacy-%s dark equals the Tailwind hex it replaced',
    (name, expected) => {
      expect(rawTokens.dark[`--color-legacy-${name}` as keyof typeof rawTokens.dark]).toBe(expected);
    },
  );

  it('matches the installed Tailwind, not a remembered table', () => {
    // If Tailwind is upgraded and its gray scale moves, the alias silently stops
    // being a no-op. This is the check that notices.
    const colors = require('tailwindcss/colors') as Record<string, never>;
    const hexToTriple = (hex: string) => {
      const h = hex.replace('#', '');
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)).join(' ');
    };
    for (const stop of ['200', '300', '400', '500', '600', '700', '800', '900', '950']) {
      expect(TAILWIND_DEFAULTS[`gray-${stop}`]).toBe(
        hexToTriple((colors as never as { gray: Record<string, string> }).gray[stop]),
      );
    }
  });
});

describe('light comes from the audit, not from a second literal', () => {
  it.each(Object.entries(LEGACY_ALIAS_LIGHT))('legacy-%s light matches the audit', (name, entry) => {
    expect(rawTokens.light[`--color-legacy-${name}` as keyof typeof rawTokens.light]).toBe(
      entry.rgb.join(' '),
    );
  });

  it('every text-role alias still clears AA on all four backdrops', () => {
    for (const [name, entry] of Object.entries(LEGACY_ALIAS_LIGHT)) {
      if (entry.role !== 'text') continue;
      expect(`${name}:${worstOnLightBackdrops(entry.rgb).toFixed(2)}`).toBe(
        `${name}:${Math.max(worstOnLightBackdrops(entry.rgb), AA_TEXT).toFixed(2)}`,
      );
    }
  });
});

describe('the root floor covers every aliased variable', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../../global.css'), 'utf8');

  it.each(Object.entries(TAILWIND_DEFAULTS))('declares --color-legacy-%s', (name, expected) => {
    expect(css).toContain(`--color-legacy-${name}: ${expected};`);
  });

  it('declares the literal escape hatches too', () => {
    expect(css).toContain('--color-pure-white: 255 255 255;');
    expect(css).toContain('--color-pure-black: 0 0 0;');
    expect(css).toContain('--color-scrim: 0 0 0;');
  });
});

describe('every gray stop the app uses is defined', () => {
  // Overriding colors.gray REPLACES the scale. A stop left out is not an error:
  // the class is simply purged and paints nothing.
  it.each(['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'])(
    'gray-%s exists in both schemes',
    (stop) => {
      expect(rawTokens.light).toHaveProperty(`--color-legacy-gray-${stop}`);
      expect(rawTokens.dark).toHaveProperty(`--color-legacy-gray-${stop}`);
    },
  );
});
