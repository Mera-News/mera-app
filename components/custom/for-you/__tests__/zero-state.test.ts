import { zeroState, type ZeroStateInput } from '../zero-state';

const base: ZeroStateInput = {
  mode: 'idle',
  noFacts: false,
  offline: false,
  articleCount: 120,
  analysedCount: 40,
  relevantCount: 6,
};

describe('zeroState', () => {
  it('says nothing when every count is there', () => {
    expect(zeroState(base)).toBeNull();
  });

  it('names the first zero', () => {
    expect(zeroState({ ...base, articleCount: 0, analysedCount: 0, relevantCount: 0 })).toBe('fetched');
    expect(zeroState({ ...base, analysedCount: 0, relevantCount: 0 })).toBe('analysed');
    expect(zeroState({ ...base, relevantCount: 0 })).toBe('relevant');
  });

  it('never says "couldn\'t analyse" while articles wait to be', () => {
    expect(zeroState({ ...base, mode: 'deferred', analysedCount: 0, relevantCount: 0 })).toBeNull();
    expect(zeroState({ ...base, mode: 'deferred', relevantCount: 0 })).toBe('relevant');
  });

  it('stays out of runs, notices and the no-facts card', () => {
    for (const mode of ['processing', 'error', 'limited'] as const) {
      expect(zeroState({ ...base, mode, articleCount: 0 })).toBeNull();
    }
    expect(zeroState({ ...base, noFacts: true, articleCount: 0 })).toBeNull();
  });

  it('blames the connection when offline', () => {
    expect(zeroState({ ...base, offline: true, articleCount: 0 })).toBe('offline');
    expect(zeroState({ ...base, offline: true })).toBeNull();
  });
});
