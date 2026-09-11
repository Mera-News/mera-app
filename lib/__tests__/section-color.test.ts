import { SECTION_SCHEME, hashString, sectionColorAtAlpha, sectionGradient } from '../section-color';

describe('hashString', () => {
  it('matches the known FNV-1a 32-bit answer for "abc"', () => {
    // FNV-1a 32-bit: offset basis 2166136261, prime 16777619.
    expect(hashString('abc')).toBe(0x1a47e90b);
  });

  it('never returns a negative number for a variety of inputs', () => {
    const inputs = [
      '',
      'a',
      'also',
      '507f1f77bcf86cd799439011',
      'ffffffffffffffffffffffff',
      '000000000000000000000000',
      'a very long string that is much longer than a typical factId, just to be safe',
    ];
    for (const input of inputs) {
      const hash = hashString(input);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('is deterministic for the same input', () => {
    expect(hashString('507f1f77bcf86cd799439011')).toBe(hashString('507f1f77bcf86cd799439011'));
  });
});

describe('sectionGradient', () => {
  it('is deterministic across repeated calls for the same factId', () => {
    const factId = '65a1b2c3d4e5f60718293a4b';
    const first = sectionGradient(factId);
    const second = sectionGradient(factId);
    expect(second).toEqual(first);
  });

  it('produces at least 3 distinct hues across realistic Mongo-ObjectId-like factIds', () => {
    const ids = [
      '507f1f77bcf86cd799439011',
      '65a1b2c3d4e5f60718293a4b',
      '000000000000000000000000',
      'ffffffffffffffffffffffff',
      '65f0a1b2c3d4e5f607182934',
    ];

    const hues = new Set(
      ids.map((id) => {
        const match = sectionGradient(id).base.match(/^hsl\((\d+),/);
        expect(match).not.toBeNull();
        return match![1];
      })
    );

    expect(hues.size).toBeGreaterThanOrEqual(3);
  });

  it('returns a spec whose shape matches the documented contract', () => {
    const ids = ['507f1f77bcf86cd799439011', 'some-other-fact-id'];
    for (const id of ids) {
      const spec = sectionGradient(id);
      expect(spec.base).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);

      const hueMatch = spec.base.match(/^hsl\((\d+),/);
      const hue = Number(hueMatch![1]);
      expect(hue).toBeLessThan(360);
      expect(hue).toBeGreaterThanOrEqual(0);

      expect(spec.startOpacity).toBeGreaterThanOrEqual(0);
      expect(spec.startOpacity).toBeLessThanOrEqual(1);
      expect(spec.endOpacity).toBeGreaterThanOrEqual(0);
      expect(spec.endOpacity).toBeLessThanOrEqual(1);
    }
  });

  it('uses the exact fixed opacities from the spec', () => {
    const spec = sectionGradient('some-fact-id');
    expect(spec.startOpacity).toBe(0.3);
    expect(spec.endOpacity).toBe(0);
  });
});

// ADDED for light mode. The dark cases above are unchanged on purpose: the
// scheme parameter defaults to 'dark', so every existing caller and assertion
// keeps its meaning.
describe('light scheme', () => {
  it('defaults to dark, so existing callers are unaffected', () => {
    expect(sectionGradient('fact-1')).toEqual(sectionGradient('fact-1', 'dark'));
  });

  it('uses a darker band and a stronger solid edge than dark mode', () => {
    // Carrying the dark pair onto Parchment collapses yellow hues to 1.11:1.
    expect(SECTION_SCHEME.light.lightness).toBeLessThan(SECTION_SCHEME.dark.lightness);
    expect(SECTION_SCHEME.light.startOpacity).toBeGreaterThan(SECTION_SCHEME.dark.startOpacity);
  });

  it('keeps the hue, and only the hue, keyed to the factId', () => {
    expect(sectionGradient('fact-1', 'light').hue).toBe(sectionGradient('fact-1', 'dark').hue);
  });

  it('builds base and hsla from the same per-scheme lightness', () => {
    const spec = sectionGradient('fact-1', 'light');
    expect(spec.base).toContain(`${SECTION_SCHEME.light.lightness}%`);
    expect(spec.lightness).toBe(SECTION_SCHEME.light.lightness);
    expect(sectionColorAtAlpha(spec.hue, 0.5, 'light')).toContain(
      `${SECTION_SCHEME.light.lightness}%`,
    );
  });

  it('reproduces the dark visibility floor across all 360 hues', () => {
    // Measured, not asserted by comment. Composite each band onto its page and
    // score band-vs-page; the light floor must not fall below the dark one by
    // more than rounding.
    const hsl2rgb = (h: number, s: number, l: number): [number, number, number] => {
      const sn = s / 100;
      const ln = l / 100;
      const c = (1 - Math.abs(2 * ln - 1)) * sn;
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = ln - c / 2;
      const seg: [number, number, number][] = [
        [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
      ];
      const [r, g, b] = seg[Math.floor(h / 60) % 6];
      return [r, g, b].map((v) => Math.round((v + m) * 255)) as [number, number, number];
    };
    const over = (fg: number[], a: number, bg: number[]) =>
      fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
    const lum = (r: number[]) => {
      const ch = (v: number) => {
        const s2 = v / 255;
        return s2 <= 0.04045 ? s2 / 12.92 : ((s2 + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r[0]) + 0.7152 * ch(r[1]) + 0.0722 * ch(r[2]);
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const floor = (page: number[], l: number, alpha: number) => {
      let min = Infinity;
      for (let h = 0; h < 360; h++) {
        min = Math.min(min, ratio(over(hsl2rgb(h, 52, l), alpha, page), page));
      }
      return min;
    };
    const dark = floor([18, 17, 19], SECTION_SCHEME.dark.lightness, SECTION_SCHEME.dark.startOpacity);
    const light = floor([244, 243, 238], SECTION_SCHEME.light.lightness, SECTION_SCHEME.light.startOpacity);
    expect(dark).toBeCloseTo(1.451, 2);
    expect(light).toBeGreaterThan(dark - 0.01);
  });
});
