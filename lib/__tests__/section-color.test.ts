import { hashString, sectionGradient } from '../section-color';
import { ALSO_ROW_ID } from '../stores/fact-rows-selector';

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

  it('maps ALSO_ROW_ID to the fixed neutral gray, not a hashed hue', () => {
    const spec = sectionGradient(ALSO_ROW_ID);
    expect(spec).toEqual({
      base: 'hsl(0, 0%, 72%)',
      startOpacity: 0.3,
      endOpacity: 0,
    });
  });

  it('returns a spec whose shape matches the documented contract', () => {
    const ids = ['507f1f77bcf86cd799439011', ALSO_ROW_ID, 'some-other-fact-id'];
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
