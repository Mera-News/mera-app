import {
  recordHeroLoad,
  resetImageStats,
  getImageResolutionReport,
  MIN_HERO_PX,
} from '../image-resolution-stats';

const sample = (over: Partial<Parameters<typeof recordHeroLoad>[0]> = {}) => ({
  upgraded: false,
  sourceHeight: 900,
  rewriteAttempted: false,
  rewriteFellBack: false,
  ...over,
});

beforeEach(() => resetImageStats());

describe('image-resolution-stats', () => {
  it('reports zeroes, not NaN, before anything has loaded', () => {
    const r = getImageResolutionReport();
    expect(r.heroesLoaded).toBe(0);
    expect(r.belowMinPct).toBe(0);
    expect(r.medianUpgradedHeight).toBeNull();
    expect(r.medianPassthroughHeight).toBeNull();
  });

  it('counts a hero below one device pixel of the hero band', () => {
    recordHeroLoad(sample({ sourceHeight: MIN_HERO_PX - 1 }));
    recordHeroLoad(sample({ sourceHeight: MIN_HERO_PX + 1 }));
    const r = getImageResolutionReport();
    expect(r.heroesLoaded).toBe(2);
    expect(r.belowMin).toBe(1);
    expect(r.belowMinPct).toBe(50);
  });

  // The three rewrite counters are defined at baseline and must read 0 there by
  // construction; P3 is what populates them.
  it('reads zero on every rewrite counter when no rewrite was attempted', () => {
    recordHeroLoad(sample());
    recordHeroLoad(sample());
    const r = getImageResolutionReport();
    expect(r.rewriteAttempted).toBe(0);
    expect(r.rewriteServed).toBe(0);
    expect(r.rewriteFellBack).toBe(0);
  });

  it('separates served rewrites from fallbacks', () => {
    recordHeroLoad(sample({ rewriteAttempted: true, upgraded: true }));
    recordHeroLoad(sample({ rewriteAttempted: true, upgraded: false, rewriteFellBack: true }));
    const r = getImageResolutionReport();
    expect(r.rewriteAttempted).toBe(2);
    expect(r.rewriteServed).toBe(1);
    expect(r.rewriteFellBack).toBe(1);
  });

  it('splits the median by upgraded vs pass-through, which is the whole point', () => {
    recordHeroLoad(sample({ upgraded: true, sourceHeight: 1000 }));
    recordHeroLoad(sample({ upgraded: true, sourceHeight: 1400 }));
    recordHeroLoad(sample({ upgraded: false, sourceHeight: 300 }));
    const r = getImageResolutionReport();
    expect(r.medianUpgradedHeight).toBe(1200);
    expect(r.medianPassthroughHeight).toBe(300);
  });

  it('ignores a non-finite or zero height rather than poisoning the median', () => {
    recordHeroLoad(sample({ sourceHeight: Number.NaN }));
    recordHeroLoad(sample({ sourceHeight: 0 }));
    const r = getImageResolutionReport();
    expect(r.heroesLoaded).toBe(2);
    expect(r.belowMin).toBe(0);
    expect(r.medianPassthroughHeight).toBeNull();
  });

  it('reset clears every counter', () => {
    recordHeroLoad(sample({ rewriteAttempted: true, upgraded: true, sourceHeight: 100 }));
    resetImageStats();
    expect(getImageResolutionReport().heroesLoaded).toBe(0);
    expect(getImageResolutionReport().rewriteServed).toBe(0);
  });
});
