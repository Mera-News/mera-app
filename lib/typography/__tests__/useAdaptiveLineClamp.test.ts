/**
 * The hook had no tests. It acquired them when the compact card's headline clamp
 * moved from 2 to 3 — that card now mocks the hook out (the jest environment
 * reports a 2x `fontScale`, so the real hook there can only ever return the
 * ceiling), and mocking it away without covering it here would have deleted the
 * only exercise of the scaling rule.
 *
 * Both inputs are mocked rather than rendered. `useWindowDimensions` and
 * `useTextScale` are the hook's only two reads, and with both stubbed to plain
 * functions nothing in the hook touches React, so it can be called directly.
 */
let mockFontScale = 1;
let mockUserScale = 1;

jest.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale: mockFontScale, width: 390, height: 844 }),
}));
jest.mock('../TextScaleContext', () => ({
  useTextScale: () => mockUserScale,
}));

import { MAX_FONT_SCALE } from '../policy';
import { useAdaptiveLineClamp } from '../useAdaptiveLineClamp';

beforeEach(() => {
  mockFontScale = 1;
  mockUserScale = 1;
});

describe('useAdaptiveLineClamp', () => {
  it('returns base exactly at 1x, so default rendering is untouched', () => {
    expect(useAdaptiveLineClamp(3, 4)).toBe(3);
  });

  it('returns base when the scales would shrink the text, never less', () => {
    mockUserScale = 0.85;
    expect(useAdaptiveLineClamp(3, 4)).toBe(3);
  });

  it('grows the allowance with the text', () => {
    mockFontScale = 1.5;
    // round(3 * 1.5) = 5, clipped by the ceiling.
    expect(useAdaptiveLineClamp(3, 6)).toBe(5);
  });

  it('never exceeds the ceiling', () => {
    mockFontScale = 2;
    expect(useAdaptiveLineClamp(3, 4)).toBe(4);
  });

  it('caps the OS contribution where the glyphs themselves stop growing', () => {
    // Past MAX_FONT_SCALE.content the text is capped, so the allowance must be
    // too — an OS scale beyond it buys no extra lines.
    mockFontScale = MAX_FONT_SCALE.content;
    const atCap = useAdaptiveLineClamp(3, 99);
    mockFontScale = MAX_FONT_SCALE.content * 4;
    expect(useAdaptiveLineClamp(3, 99)).toBe(atCap);
  });

  it('compounds the OS scale with the in-app text-size control', () => {
    mockFontScale = 1.2;
    mockUserScale = 1.3;
    // round(2 * 1.2 * 1.3) = round(3.12) = 3
    expect(useAdaptiveLineClamp(2, 9)).toBe(3);
  });

  it('defaults the ceiling to twice base', () => {
    mockFontScale = MAX_FONT_SCALE.content;
    mockUserScale = 4;
    expect(useAdaptiveLineClamp(3)).toBe(6);
  });
});
