import { formatMb, planRatio } from '@/lib/subscription/reading-plans';

describe('reading plans copy helpers', () => {
  it('states a ratio only for a real step up', () => {
    expect(planRatio(20_000_000, 4_000_000)).toBe(5);
    expect(planRatio(100_000_000, 20_000_000)).toBe(5);
    expect(planRatio(20_000_000, 3_000_000)).toBe(7);
    expect(planRatio(4_000_000, 4_000_000)).toBeNull();
    expect(planRatio(20_000_000, 0)).toBeNull();
  });

  it('writes decimal megabytes the way copy does', () => {
    expect(formatMb(4_000_000)).toBe('4 MB');
    expect(formatMb(100_000_000)).toBe('100 MB');
    expect(formatMb(2_500_000)).toBe('2.5 MB');
  });
});
