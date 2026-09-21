import { isCulledHeadlineRelevance } from '../importance-filter';

// relevance v3 (2026-08-05) band-ladder unification: `relevanceBandRank` (which
// this module is built on) moved off its own 0.53/0.77 cutoffs onto the unified
// `bandOf` cutoffs — 0.4 (RENDER_GATE, also the LOW floor) / 0.6 / 0.8.
//
// The user-tunable importance dial that used to live in this module, and the
// suites that covered it, are gone with the control. What remains is the
// score-persist-time headline cull, which was never part of that dial and is
// the reason the module survives.

describe('isCulledHeadlineRelevance', () => {
  it('culls the LOW band and below', () => {
    expect(isCulledHeadlineRelevance(0.59)).toBe(true);
    expect(isCulledHeadlineRelevance(0.4)).toBe(true);
    expect(isCulledHeadlineRelevance(0.2)).toBe(true);
    expect(isCulledHeadlineRelevance(0)).toBe(true);
  });

  it('keeps medium and above', () => {
    expect(isCulledHeadlineRelevance(0.6)).toBe(false);
    expect(isCulledHeadlineRelevance(0.8)).toBe(false);
    expect(isCulledHeadlineRelevance(1.1)).toBe(false);
  });

  it('culls the headline floor ceiling (0.5 < medium band)', () => {
    // HEADLINE_BASE_FLOOR 0.35 + HEADLINE_POP_LIFT 0.15 · popComp(1) = 0.5
    expect(isCulledHeadlineRelevance(0.5)).toBe(true);
  });
});
