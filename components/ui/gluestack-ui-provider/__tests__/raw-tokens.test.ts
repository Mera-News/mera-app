// THE FROZEN-DARK CONTRACT.
//
// Adding light mode must not restyle the dark mode already shipped. The previous
// attempt rebranded the dark ramp while adding light, which turned "add light
// mode" into "add light mode AND redesign dark", doubled the review surface and
// is a large part of why that branch died.
//
// So: the dark token block is pinned against a committed snapshot. Any edit to
// config.ts that changes a dark value fails here. If this test fails and you
// believe the new dark value is correct, you are on the wrong wave.

import fs from 'node:fs';
import path from 'node:path';

import { rawTokens } from '../config';

describe('rawTokens.dark is frozen', () => {
  it('matches the committed snapshot', () => {
    expect(rawTokens.dark).toMatchSnapshot();
  });
});

describe('rawTokens key parity', () => {
  it('light and dark define exactly the same variables', () => {
    expect(Object.keys(rawTokens.light).sort()).toEqual(Object.keys(rawTokens.dark).sort());
  });

  it('every value is a bare "r g b" triple, which is what vars() expects', () => {
    const bad: string[] = [];
    for (const block of [rawTokens.light, rawTokens.dark]) {
      for (const [k, v] of Object.entries(block)) {
        if (!/^\d{1,3} \d{1,3} \d{1,3}$/.test(v)) bad.push(`${k}: ${v}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('defines a 0 stop for every ramp, including tertiary', () => {
    const ramps = [
      'primary',
      'secondary',
      'tertiary',
      'error',
      'success',
      'warning',
      'info',
      'typography',
      'outline',
      'background',
    ];
    for (const ramp of ramps) {
      expect(Object.keys(rawTokens.light)).toContain(`--color-${ramp}-0`);
    }
  });
});

describe('raw-tokens.ts stays import-free', () => {
  // nativewind touches react-native-css-interop's appearance observables at
  // module load, so anything importing it dies in a suite that mocks
  // react-native. lib/theme imports these tokens and P4 puts useThemeColors in
  // ~119 files, so one import added here would break the app's test suite in
  // places that name neither this file nor the change.
  it('has no import statements at all', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../raw-tokens.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
    expect(imports).toEqual([]);
  });

  it('is what config re-exports, so there is still one source', () => {
    const raw = require('../raw-tokens') as { rawTokens: typeof rawTokens };
    expect(raw.rawTokens).toBe(rawTokens);
  });
});
